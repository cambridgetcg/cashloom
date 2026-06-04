// Pull the Cloudinary public_id out of a stored secure URL so the asset can be
// deleted. e.g.
//   https://res.cloudinary.com/x/image/upload/v1700/images/abc.jpg -> images/abc
// Returns null if it doesn't look like a Cloudinary upload URL. Pure so it's
// easy to test.
export const publicIdFromUrl = (url: string): string | null => {
  if (typeof url !== "string") return null;

  const marker = "/upload/";
  const idx = url.indexOf(marker);
  if (idx === -1) return null;

  let rest = url.slice(idx + marker.length);
  rest = rest.split(/[?#]/)[0]; // drop any query/hash
  rest = rest.replace(/^v\d+\//, ""); // drop the version segment
  rest = rest.replace(/\.[a-zA-Z0-9]+$/, ""); // drop the file extension

  return rest || null;
};
