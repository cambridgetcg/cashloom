import AccountModel from "../models/account.model";
import { NotFoundException } from "../utils/app-error";
import {
  CreateAccountType,
  UpdateAccountType,
} from "../validators/account.validator";

export const createAccountService = async (
  body: CreateAccountType,
  userId: string
) => {
  const account = await AccountModel.create({
    ...body,
    userId,
  });

  return account;
};

export const getAllAccountsService = async (userId: string) => {
  const accounts = await AccountModel.find({ userId }).sort({ createdAt: -1 });

  return { accounts };
};

export const getAccountByIdService = async (
  userId: string,
  accountId: string
) => {
  // Scoped by userId as well as _id so a guessed id can't read another owner's
  // account (closes the IDOR class the ROADMAP called out on single-record gets).
  const account = await AccountModel.findOne({ _id: accountId, userId });
  if (!account) throw new NotFoundException("Account not found");

  return account;
};

export const updateAccountService = async (
  userId: string,
  accountId: string,
  body: UpdateAccountType
) => {
  const account = await AccountModel.findOne({ _id: accountId, userId });
  if (!account) throw new NotFoundException("Account not found");

  account.set({
    ...(body.displayName && { displayName: body.displayName }),
    ...(body.connectorType && { connectorType: body.connectorType }),
    ...(body.currency && { currency: body.currency }),
    ...(body.decimals !== undefined && { decimals: body.decimals }),
    ...(body.status && { status: body.status }),
  });

  await account.save();

  return account;
};
