// Haus (Wroom): fetch the original image from the `imageUrl` of a default (base64 JSON) request.
// No host, address, scheme or size restrictions by decision (docs/plans/wroom-improvements.md, 2026-10-16):
// every URL that the 6.x fork fetched is still fetched.

import sharp from "sharp";

import { ContentTypes, DefaultImageRequest, ImageEdits, ImageHandlerError, StatusCodes } from "./lib";

// Just under API Gateway's 29 s integration timeout, so a hanging source gives a clear 504.
export const URL_FETCH_TIMEOUT_MS = 25_000;

const CACHE_CONTROL = "max-age=31536000,public";
const FORMAT_EDITS = ["jpeg", "png", "webp", "gif", "avif", "tiff", "heif"];

export type UrlImageInfo = {
  contentType: string;
  cacheControl: string;
  originalImage: Buffer;
};

/**
 * Whether a decoded default request uses the URL source. A present but falsy `imageUrl` (the WordPress plugin sends
 * `false`) counts, so it fails as a 400 instead of falling back to S3.
 * @param request Decoded default request.
 * @returns True when the request has an `imageUrl` property.
 */
export function isUrlRequest(request: DefaultImageRequest): boolean {
  return request !== null && typeof request === "object" && Object.prototype.hasOwnProperty.call(request, "imageUrl");
}

/**
 * Validates the URL request fields that the 6.x fork already required.
 * @param request Decoded default request.
 * @returns The image URL.
 */
export function parseImageUrl(request: DefaultImageRequest): string {
  if (!request.publicKey) {
    throw new ImageHandlerError(
      StatusCodes.BAD_REQUEST,
      "OriginAndSourceValidation::MissingPublicApiKey",
      "The request is missing the property `publicKey`"
    );
  }

  const { imageUrl } = request;
  if (typeof imageUrl !== "string" || imageUrl.trim() === "") {
    throw new ImageHandlerError(StatusCodes.BAD_REQUEST, "ImageUrl::Missing", "The request has no image URL.");
  }

  try {
    new URL(imageUrl);
  } catch {
    throw new ImageHandlerError(StatusCodes.BAD_REQUEST, "ImageUrl::InvalidUrl", "The image URL is not a valid URL.");
  }

  return imageUrl;
}

/**
 * Maps a source HTTP status to the status Wroom returns.
 * @param status Source response status.
 * @returns Error to throw.
 */
function sourceStatusError(status: number): ImageHandlerError {
  if (status === 404 || status === 410) {
    return new ImageHandlerError(StatusCodes.NOT_FOUND, "ImageUrl::NotFound", "The source image does not exist.");
  }
  if (status >= 400 && status < 500) {
    return new ImageHandlerError(
      StatusCodes.BAD_REQUEST,
      "ImageUrl::SourceRejected",
      `The source refused the request (HTTP ${status}).`
    );
  }
  return new ImageHandlerError(
    StatusCodes.BAD_GATEWAY,
    "ImageUrl::SourceError",
    `The source failed to return the image (HTTP ${status}).`
  );
}

/**
 * Content type of the source image. Never rejects: a known image header wins (the only way to recognise SVG), then
 * magic bytes, then sharp's own detection. Unknown stays "image", as in the 6.x fork, and sharp decides later.
 * @param header Source Content-Type header.
 * @param buffer Source body.
 * @returns Content type.
 */
export async function resolveContentType(header: string | null, buffer: Buffer): Promise<string> {
  const mediaType = (header ?? "").split(";")[0].trim().toLowerCase();
  if ((Object.values(ContentTypes) as string[]).includes(mediaType)) {
    return mediaType;
  }

  const signature = buffer.subarray(0, 4).toString("hex").toUpperCase();
  const signatures: Record<string, string> = {
    "89504E47": ContentTypes.PNG,
    "52494646": ContentTypes.WEBP,
    "49492A00": ContentTypes.TIFF,
    "4D4D002A": ContentTypes.TIFF,
    "47494638": ContentTypes.GIF,
  };
  if (signatures[signature]) return signatures[signature];
  if (buffer.subarray(0, 2).toString("hex").toUpperCase() === "FFD8") return ContentTypes.JPEG;
  if (buffer.subarray(4, 12).toString("hex").toUpperCase() === "6674797061766966") return ContentTypes.AVIF;

  try {
    const { format } = await sharp(buffer).metadata();
    const byFormat: Record<string, string> = {
      svg: ContentTypes.SVG,
      jpeg: ContentTypes.JPEG,
      png: ContentTypes.PNG,
      webp: ContentTypes.WEBP,
      gif: ContentTypes.GIF,
      tiff: ContentTypes.TIFF,
      heif: "image/heif",
    };
    if (format) return byFormat[format] ?? `image/${format}`;
  } catch {
    // Not an image sharp can read; sharp fails with a 400 when the image is processed.
  }
  return "image";
}

/**
 * Downloads the source image.
 * @param imageUrl Source URL.
 * @param timeoutMs Timeout for the whole download.
 * @returns Image buffer, content type and cache control.
 */
export async function getOriginalImageFromUrl(
  imageUrl: string,
  timeoutMs: number = URL_FETCH_TIMEOUT_MS
): Promise<UrlImageInfo> {
  let response: Response;
  try {
    response = await fetch(imageUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    console.error(`Fetching ${imageUrl} failed:`, error);
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ImageHandlerError(
        StatusCodes.GATEWAY_TIMEOUT,
        "ImageUrl::Timeout",
        "The source did not answer in time."
      );
    }
    throw new ImageHandlerError(StatusCodes.BAD_GATEWAY, "ImageUrl::FetchFailed", "The source could not be reached.");
  }

  if (!response.ok) {
    console.error(`Fetching ${imageUrl} returned HTTP ${response.status}`);
    throw sourceStatusError(response.status);
  }

  let originalImage: Buffer;
  try {
    originalImage = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error(`Reading ${imageUrl} failed:`, error);
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ImageHandlerError(
        StatusCodes.GATEWAY_TIMEOUT,
        "ImageUrl::Timeout",
        "The source did not answer in time."
      );
    }
    throw new ImageHandlerError(StatusCodes.BAD_GATEWAY, "ImageUrl::FetchFailed", "The source could not be read.");
  }

  return {
    contentType: await resolveContentType(response.headers.get("content-type"), originalImage),
    cacheControl: CACHE_CONTROL,
    originalImage,
  };
}

/**
 * Content type when a format edit (for example `{"webp": {"quality": 85}}`) sets the output without `toFormat` or
 * AutoWebP. sharp then encodes in that format, so the header must say so.
 * @param edits Request edits.
 * @returns Content type, or undefined when no format edit is present.
 */
export function contentTypeFromFormatEdit(edits: ImageEdits | undefined): string | undefined {
  if (!edits) return undefined;
  const format = Object.keys(edits).find((key) => FORMAT_EDITS.includes(key));
  return format ? `image/${format}` : undefined;
}
