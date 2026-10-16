// Haus (Wroom): tests for the imageUrl source. A local HTTP server stands in for customer image hosts.

import fs from "fs";
import http from "http";
import { AddressInfo } from "net";
import path from "path";
import sharp from "sharp";

import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { RekognitionClient } from "@aws-sdk/client-rekognition";

import { mockS3Commands } from "./mock";
import { handler } from "../index";
import { ImageHandler } from "../image-handler";
import { ImageRequest } from "../image-request";
import { ContentTypes, ImageHandlerError, ImageHandlerExecutionResult, StatusCodes } from "../lib";
import { SecretProvider } from "../secret-provider";
import {
  contentTypeFromFormatEdit,
  getOriginalImageFromUrl,
  isUrlRequest,
  parseImageUrl,
  resolveContentType,
} from "../url-image-source";

const image = (name: string) => fs.readFileSync(path.join(__dirname, "image", name));
const JPEG = image("transparent-10x10.jpeg");
const PNG = image("25x15.png");
const GIF = image("transparent-5x5-2page.gif");
const SVG = image("10x10.svg");
const BMP = image("2x2.bmp");

type Route = (res: http.ServerResponse) => void;
const send =
  (status: number, body: Buffer | string, contentType?: string): Route =>
  (res) => {
    res.writeHead(status, contentType ? { "Content-Type": contentType } : {});
    res.end(body);
  };

const routes: Record<string, Route> = {
  "/photo.jpg": send(200, JPEG, "image/jpeg"),
  "/photo.png": send(200, PNG, "image/png"),
  "/octet.jpg": send(200, JPEG, "application/octet-stream"),
  "/plain.png": send(200, PNG, "text/plain"),
  "/none.png": send(200, PNG),
  "/vector.svg": send(200, SVG, "image/svg+xml"),
  "/vector-plain.svg": send(200, SVG, "text/plain"),
  "/anim.gif": send(200, GIF, "image/gif"),
  "/bitmap.bmp": send(200, BMP, "image/bmp"),
  "/garbage": send(200, "not an image at all", "text/html"),
  "/missing.jpg": send(404, "404", "text/html"),
  "/gone.jpg": send(410, "gone"),
  "/forbidden.jpg": send(403, "no"),
  "/broken.jpg": send(500, "oops"),
  "/redirect.jpg": (res) => {
    res.writeHead(302, { Location: "/photo.jpg" });
    res.end();
  },
  "/slow-body.jpg": (res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": "100000" });
    res.write(JPEG.subarray(0, 10));
  },
  "/cut-body.jpg": (res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": "100000" });
    res.write(JPEG.subarray(0, 10), () => res.destroy());
  },
  "/hang.jpg": () => {
    // never answers
  },
};

describe("url-image-source", () => {
  let server: http.Server;
  let base: string;
  let closedPortUrl: string;
  const OLD_ENV = process.env;

  beforeAll(async () => {
    server = http.createServer((req, res) => (routes[req.url ?? ""] ?? send(404, "unknown route"))(res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    closedPortUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/x.jpg`;
    await new Promise((resolve) => closed.close(resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    Object.values(mockS3Commands).forEach((mock) => mock.mockReset());
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  const expectError = async (promise: Promise<unknown>, status: StatusCodes, code: string) => {
    await expect(promise).rejects.toMatchObject({ status, code });
  };

  describe("isUrlRequest and parseImageUrl", () => {
    it("treats a present imageUrl, even false, as a URL request", () => {
      expect(isUrlRequest({ key: undefined, imageUrl: false })).toBe(true);
      expect(isUrlRequest({ key: "a.jpg" })).toBe(false);
    });

    it("requires publicKey as the 6.x fork did", () => {
      expect(() => parseImageUrl({ key: undefined, imageUrl: `${base}/photo.jpg` })).toThrow(
        expect.objectContaining({ status: 400, code: "OriginAndSourceValidation::MissingPublicApiKey" })
      );
    });

    it.each([false, "", "   ", null])("returns 400 for a missing image URL (%p)", (imageUrl) => {
      expect(() => parseImageUrl({ key: undefined, publicKey: "noKey", imageUrl: imageUrl as string })).toThrow(
        expect.objectContaining({ status: 400, code: "ImageUrl::Missing" })
      );
    });

    it("returns 400 for an invalid URL", () => {
      expect(() => parseImageUrl({ key: undefined, publicKey: "noKey", imageUrl: "not a url" })).toThrow(
        expect.objectContaining({ status: 400, code: "ImageUrl::InvalidUrl" })
      );
    });

    it("accepts any URL, including loopback (no blocking by decision)", () => {
      expect(parseImageUrl({ key: undefined, publicKey: "noKey", imageUrl: "http://127.0.0.1:20001/a.jpg" })).toBe(
        "http://127.0.0.1:20001/a.jpg"
      );
    });
  });

  describe("getOriginalImageFromUrl", () => {
    it("downloads an image with its content type and a one-year cache", async () => {
      const result = await getOriginalImageFromUrl(`${base}/photo.jpg`);
      expect(result).toEqual({
        contentType: ContentTypes.JPEG,
        cacheControl: "max-age=31536000,public",
        originalImage: JPEG,
      });
    });

    it("follows redirects", async () => {
      expect((await getOriginalImageFromUrl(`${base}/redirect.jpg`)).originalImage).toEqual(JPEG);
    });

    it.each([
      ["/missing.jpg", StatusCodes.NOT_FOUND, "ImageUrl::NotFound"],
      ["/gone.jpg", StatusCodes.NOT_FOUND, "ImageUrl::NotFound"],
      ["/forbidden.jpg", StatusCodes.BAD_REQUEST, "ImageUrl::SourceRejected"],
      ["/broken.jpg", StatusCodes.BAD_GATEWAY, "ImageUrl::SourceError"],
    ])("maps source %s to %d", async (route, status, code) => {
      await expectError(getOriginalImageFromUrl(`${base}${route}`), status, code);
    });

    it("maps an unreachable source to 502 without leaking the network error", async () => {
      const error: ImageHandlerError = await getOriginalImageFromUrl(closedPortUrl).catch((e) => e);
      expect(error).toMatchObject({ status: StatusCodes.BAD_GATEWAY, code: "ImageUrl::FetchFailed" });
      expect(error.message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
    });

    it("maps a hanging source to 504", async () => {
      await expectError(
        getOriginalImageFromUrl(`${base}/hang.jpg`, 200),
        StatusCodes.GATEWAY_TIMEOUT,
        "ImageUrl::Timeout"
      );
    });

    it("maps a source that stalls mid-body to 504", async () => {
      await expectError(
        getOriginalImageFromUrl(`${base}/slow-body.jpg`, 200),
        StatusCodes.GATEWAY_TIMEOUT,
        "ImageUrl::Timeout"
      );
    });

    it("maps a source that drops the connection mid-body to 502", async () => {
      await expectError(
        getOriginalImageFromUrl(`${base}/cut-body.jpg`),
        StatusCodes.BAD_GATEWAY,
        "ImageUrl::FetchFailed"
      );
    });

    it.each([
      ["/octet.jpg", ContentTypes.JPEG],
      ["/plain.png", ContentTypes.PNG],
      ["/none.png", ContentTypes.PNG],
      ["/vector.svg", ContentTypes.SVG],
      ["/vector-plain.svg", ContentTypes.SVG],
      ["/anim.gif", ContentTypes.GIF],
      ["/garbage", "image"],
    ])("never rejects on content type: %s becomes %s", async (route, contentType) => {
      expect((await getOriginalImageFromUrl(`${base}${route}`)).contentType).toBe(contentType);
    });
  });

  describe("resolveContentType", () => {
    it("ignores parameters and case in the header", async () => {
      expect(await resolveContentType("Image/PNG; charset=binary", PNG)).toBe(ContentTypes.PNG);
    });

    it("recognises AVIF by magic bytes", async () => {
      const avif = Buffer.concat([Buffer.from("0000001c", "hex"), Buffer.from("ftypavif"), Buffer.alloc(8)]);
      expect(await resolveContentType(null, avif)).toBe(ContentTypes.AVIF);
    });

    it("recognises TIFF by magic bytes", async () => {
      const tiff = await sharp(PNG).tiff().toBuffer();
      expect(await resolveContentType(null, tiff)).toBe(ContentTypes.TIFF);
    });
  });

  describe("contentTypeFromFormatEdit", () => {
    it("labels the format set by a format edit", () => {
      expect(contentTypeFromFormatEdit({ resize: { width: 10 }, webp: { quality: 85 } })).toBe(ContentTypes.WEBP);
      expect(contentTypeFromFormatEdit({ resize: { width: 10 } })).toBeUndefined();
      expect(contentTypeFromFormatEdit(undefined)).toBeUndefined();
    });
  });

  describe("ImageRequest.setup and ImageHandler.process with imageUrl", () => {
    const imageRequest = new ImageRequest(new S3Client(), new SecretProvider(new SecretsManagerClient()));
    const imageHandler = new ImageHandler(new S3Client(), new RekognitionClient());
    const event = (request: object, accept = "*/*") => ({
      path: `/${Buffer.from(JSON.stringify(request)).toString("base64")}`,
      headers: { Accept: accept },
    });

    it("WordPress shape: string width, webp edit, blur, AutoWebP with Accept image/webp", async () => {
      process.env.AUTO_WEBP = "Yes";
      const info = await imageRequest.setup(
        event(
          {
            imageUrl: `${base}/photo.png`,
            publicKey: "noKey",
            edits: { resize: { width: "10", fit: "cover", withoutEnlargement: true }, webp: { quality: 85 }, blur: 8 },
          },
          "image/avif,image/webp,*/*"
        )
      );
      expect(info.contentType).toBe(ContentTypes.WEBP);
      expect(mockS3Commands.getObject).not.toHaveBeenCalled();
      const output = await sharp(await imageHandler.process(info)).metadata();
      expect(output).toMatchObject({ format: "webp", width: 10 });
    });

    it("webp edit without toFormat and Accept */* is labelled webp", async () => {
      process.env.AUTO_WEBP = "Yes";
      const info = await imageRequest.setup(
        event({ imageUrl: `${base}/photo.png`, publicKey: "noKey", edits: { webp: { quality: 85 } } })
      );
      expect(info.contentType).toBe(ContentTypes.WEBP);
      expect((await sharp(await imageHandler.process(info)).metadata()).format).toBe("webp");
    });

    it("no format edit and Accept */* keeps the source format with a real content type", async () => {
      process.env.AUTO_WEBP = "Yes";
      const info = await imageRequest.setup(
        event({ imageUrl: `${base}/photo.jpg`, publicKey: "noKey", edits: { resize: { width: 300 } } })
      );
      expect(info.contentType).toBe(ContentTypes.JPEG);
      expect((await sharp(await imageHandler.process(info)).metadata()).format).toBe("jpeg");
    });

    it("toFormat wins over a format edit", async () => {
      const info = await imageRequest.setup(
        event({ imageUrl: `${base}/photo.png`, publicKey: "noKey", edits: { toFormat: "jpeg", webp: {} } })
      );
      expect(info.contentType).toBe(ContentTypes.JPEG);
    });

    it("Hemglass shape: resize without width or height", async () => {
      const info = await imageRequest.setup(
        event({
          imageUrl: `${base}/photo.png`,
          publicKey: "noKey",
          edits: { resize: { fit: "cover", withoutEnlargement: true, position: "centre" }, toFormat: "webp" },
        })
      );
      expect((await sharp(await imageHandler.process(info)).metadata()).format).toBe("webp");
    });

    it("extract edit works", async () => {
      const info = await imageRequest.setup(
        event({
          imageUrl: `${base}/photo.png`,
          publicKey: "noKey",
          edits: { extract: { left: 0, top: 0, width: 5, height: 5 }, toFormat: "png" },
        })
      );
      expect(await sharp(await imageHandler.process(info)).metadata()).toMatchObject({ width: 5, height: 5 });
    });

    it("SVG with a resize is rasterized to PNG", async () => {
      const info = await imageRequest.setup(
        event({ imageUrl: `${base}/vector.svg`, publicKey: "noKey", edits: { resize: { width: 5 } } })
      );
      expect(info.contentType).toBe(ContentTypes.PNG);
      expect((await sharp(await imageHandler.process(info)).metadata()).format).toBe("png");
    });

    it.each([
      // Same as v8.1.2 for S3 sources: the output format decides, so webp output is one frame, as in the 6.x fork.
      [{ resize: { width: 5 }, toFormat: "webp" }, "*/*", false],
      [{ resize: { width: 5 } }, "image/webp", false],
      [{ resize: { width: 5 } }, "*/*", true],
    ])("animated GIF with edits %j and Accept %s opens animated=%s", async (edits, accept, animated) => {
      process.env.AUTO_WEBP = "Yes";
      const info = await imageRequest.setup(event({ imageUrl: `${base}/anim.gif`, publicKey: "noKey", edits }, accept));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instantiateSpy = jest.spyOn<any, "instantiateSharpImage">(imageHandler, "instantiateSharpImage");
      await imageHandler.process(info);
      expect(instantiateSpy).toHaveBeenLastCalledWith(
        info.originalImage,
        info.edits,
        expect.objectContaining({ animated })
      );
      instantiateSpy.mockRestore();
    });

    it("imageUrl false is a 400 and never reaches S3", async () => {
      process.env.SOURCE_BUCKETS = "bucket";
      await expectError(
        imageRequest.setup(event({ imageUrl: false, publicKey: "noKey", edits: { resize: { width: 300 } } })),
        StatusCodes.BAD_REQUEST,
        "ImageUrl::Missing"
      );
      expect(mockS3Commands.getObject).not.toHaveBeenCalled();
    });
  });

  describe("handler", () => {
    const apiEvent = (request: object) => ({
      path: `/${Buffer.from(JSON.stringify(request)).toString("base64")}`,
      headers: { Accept: "image/webp" },
      requestContext: {},
    });

    it("returns 404 with a JSON body for a missing source", async () => {
      const result = (await handler(
        apiEvent({ imageUrl: `${base}/missing.jpg`, publicKey: "noKey", edits: {} })
      )) as ImageHandlerExecutionResult;
      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body as string)).toMatchObject({ code: "ImageUrl::NotFound" });
    });

    it("returns 200 webp for a WordPress request", async () => {
      process.env.AUTO_WEBP = "Yes";
      const result = (await handler(
        apiEvent({ imageUrl: `${base}/photo.png`, publicKey: "noKey", edits: { resize: { width: "10" } } })
      )) as ImageHandlerExecutionResult;
      expect(result.statusCode).toBe(200);
      expect(result.headers["Content-Type"]).toBe(ContentTypes.WEBP);
      expect(result.headers["Cache-Control"]).toBe("max-age=31536000,public");
    });

    it("a BMP source fails as before (sharp cannot read it) without a 500", async () => {
      const result = (await handler(
        apiEvent({ imageUrl: `${base}/bitmap.bmp`, publicKey: "noKey", edits: { resize: { width: 1 } } })
      )) as ImageHandlerExecutionResult;
      expect(result.statusCode).toBe(400);
    });
  });
});
