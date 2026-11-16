// Reads and writes JPEG images for redact.js, with what the browser has: it can draw a JPEG on a
// canvas and save a canvas as JPEG. Used in the worker; where there is no OffscreenCanvas the
// codec is null and JPEG images under a private mark are removed as a whole instead.
//
// decodeJpeg(bytes)             → { width, height, rgb }   (rgb: 3 bytes per pixel)
// encodeJpeg({ width, height, rgb }) → Uint8Array

const QUALITY = 0.92; // a blanked scan is saved again as JPEG: this keeps the rest sharp

export const imageCodec =
  typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined"
    ? null
    : {
        async decodeJpeg(bytes) {
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
          const { width, height } = bitmap;
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext("2d", { willReadFrequently: true });
          context.drawImage(bitmap, 0, 0);
          bitmap.close?.();
          const { data } = context.getImageData(0, 0, width, height);
          const rgb = new Uint8Array(width * height * 3);
          for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
            rgb[j] = data[i];
            rgb[j + 1] = data[i + 1];
            rgb[j + 2] = data[i + 2];
          }
          return { width, height, rgb };
        },

        async encodeJpeg({ width, height, rgb }) {
          const rgba = new Uint8ClampedArray(width * height * 4);
          for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
            rgba[i] = rgb[j];
            rgba[i + 1] = rgb[j + 1];
            rgba[i + 2] = rgb[j + 2];
            rgba[i + 3] = 255;
          }
          const canvas = new OffscreenCanvas(width, height);
          canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
          const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: QUALITY });
          return new Uint8Array(await blob.arrayBuffer());
        },
      };
