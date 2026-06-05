import UserModel from "../models/user.model";
import { NotFoundException } from "../utils/app-error";
import { UpdateUserType } from "../validators/user.validator";
import { deleteImageByUrl } from "../config/cloudinary.config";

export const findByIdUserService = async (userId: string) => {
  const user = await UserModel.findById(userId);
  return user?.omitPassword();
};

export const updateUserService = async (
  userId: string,
  body: UpdateUserType,
  profilePic?: Express.Multer.File
) => {
  const user = await UserModel.findById(userId);
  if (!user) throw new NotFoundException("User not found");

  const previousPicture = user.profilePicture;

  if (profilePic) {
    user.profilePicture = profilePic.path;
  }

  user.set({
    name: body.name,
    ...(body.currency && { currency: body.currency }),
  });

  await user.save();

  // Best-effort: drop the replaced avatar so old assets don't accrue cost.
  if (
    profilePic &&
    previousPicture &&
    previousPicture !== user.profilePicture
  ) {
    await deleteImageByUrl(previousPicture);
  }

  return user.omitPassword();
};
