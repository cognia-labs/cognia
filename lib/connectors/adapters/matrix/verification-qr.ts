import jsQR from "jsqr"

/** Matrix verification QR is binary. A text-only scanner corrupts its keys. */
export function decodeMatrixVerificationPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number
): number[] {
  if (
    width < 1 ||
    height < 1 ||
    width > 2048 ||
    height > 2048 ||
    data.length !== width * height * 4
  )
    throw new Error("Invalid QR image dimensions")
  const result = jsQR(data, width, height)
  const bytes = result?.binaryData
  if (
    !bytes ||
    bytes.length > 4096 ||
    bytes.length < 8 ||
    String.fromCharCode(...bytes.slice(0, 6)) !== "MATRIX"
  )
    throw new Error("Invalid Matrix verification QR image")
  return bytes
}

export async function decodeMatrixVerificationFile(file: File): Promise<number[]> {
  if (file.size > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Unsupported QR image")
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    if (image.naturalWidth > 2048 || image.naturalHeight > 2048)
      throw new Error("QR image is too large")
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) throw new Error("QR image decoder unavailable")
    context.drawImage(image, 0, 0)
    return decodeMatrixVerificationPixels(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width,
      canvas.height
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}
