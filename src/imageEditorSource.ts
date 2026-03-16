const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  tif: "image/tiff"
};

export function inferImageMimeType(path: string): string {
  const cleaned = path.split("?")[0].split("#")[0];
  const lastDot = cleaned.lastIndexOf(".");
  if (lastDot < 0 || lastDot === cleaned.length - 1) return "image/png";
  const ext = cleaned.slice(lastDot + 1).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? "image/png";
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}
