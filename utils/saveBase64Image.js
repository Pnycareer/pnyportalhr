const fs = require("fs");
const path = require("path");

const SUPPORTED_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveBase64Image(dataUri, options = {}) {
  if (!dataUri || typeof dataUri !== "string") {
    throw new Error("Invalid image payload");
  }

  const matches = dataUri.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!matches) {
    throw new Error("Image must be a base64 data URI");
  }

  const mimeType = matches[1].toLowerCase();
  const base64Data = matches[2];

  const ext = SUPPORTED_TYPES[mimeType];
  if (!ext) {
    throw new Error("Unsupported image type");
  }

  const buffer = Buffer.from(base64Data, "base64");
  const dir =
    options.absoluteDir ||
    path.join(process.cwd(), "uploads", options.subFolder || "signatures");

  ensureDir(dir);

  const fileName =
    options.fileName || `${Date.now()}${Math.random().toString(16).slice(2)}${ext}`;

  const absolutePath = path.join(dir, fileName);
  fs.writeFileSync(absolutePath, buffer);

  const relativePath = `/uploads/${options.subFolder || "signatures"}/${fileName}`;

  return { absolutePath, relativePath };
}

module.exports = saveBase64Image;

