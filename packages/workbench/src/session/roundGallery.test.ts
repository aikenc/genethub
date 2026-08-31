import { describe, expect, it } from "vitest";

import type { BlobOverview, RoundBatch, RoundTrunk } from "@genehub/proto";

import {
  appendUnlinkedThumbs,
  finalGalleryFromTrunks,
  galleryNotInMarkdown,
  hoistedImageIds,
  inlineImagesFromTrunks,
  isImageOnlyBatch,
  isProducedImage,
  isSafeInlineImageDataUrl,
  markdownLinkedImagePaths,
  rewriteLinkedImagesToThumbs,
  thumbDataUrl,
  thumbForPath,
  visibleProcessBatches,
} from "./roundGallery";

const thumb = { mime: "image/jpeg", dataBase64: "dGh1bWI=", width: 128, height: 64 };

function image(id: string, path: string): BlobOverview {
  return { itemId: id, kind: "image", overview: id, thumb, path };
}

function batch(
  index: number,
  firstItemId: string,
  blobs: BlobOverview[],
  extras: Partial<RoundBatch> = {},
): RoundBatch {
  return {
    summary: {
      index,
      firstItemId,
      blobCount: blobs.filter((row) => row.kind !== "image").length || blobs.length,
      text: extras.summary?.text ?? firstItemId,
    },
    monologue: extras.monologue,
    blobs,
  };
}

describe("round gallery", () => {
  it("treats session-directory images as produced", () => {
    expect(isProducedImage(image("a", ".genethub/sessions/s1/images/aa.png"))).toBe(true);
    expect(isProducedImage(image("b", "assets/logo.png"))).toBe(false);
  });

  it("hoists produced images from the last visible batch of a settled round", () => {
    const produced = image("t1:img:0", ".genethub/sessions/s1/images/aa.png");
    const trunk: RoundTrunk = {
      summary: {
        index: 0,
        firstItemId: "t1",
        blobCount: 1,
        title: "画",
        batches: [],
      },
      batches: [
        batch(0, "t1", [{ itemId: "t1", kind: "toolCall", overview: "gen" }]),
        batch(1, "t1:img:0", [produced], { summary: { text: "1 张图片" } as never }),
        batch(2, "a2", [], { monologue: "画好了。", summary: { text: "画好了。", blobCount: 0 } as never }),
      ],
    };
    trunk.batches[2]!.summary = {
      index: 2,
      firstItemId: "a2",
      blobCount: 0,
      text: "画好了。",
    };
    const gallery = finalGalleryFromTrunks([trunk], "completed", "画好了。");
    expect(gallery.map((row) => row.itemId)).toEqual(["t1:img:0"]);
  });

  it("does not hoist while the round is running or when work follows", () => {
    const produced = image("t1:img:0", ".genethub/sessions/s1/images/aa.png");
    const imageBatch = batch(1, "t1:img:0", [produced]);
    const moreWork = batch(2, "t2", [{ itemId: "t2", kind: "toolCall", overview: "read" }]);
    const trunk: RoundTrunk = {
      summary: { index: 0, firstItemId: "t1", blobCount: 2, title: "画", batches: [] },
      batches: [batch(0, "t1", [{ itemId: "t1", kind: "toolCall", overview: "gen" }]), imageBatch],
    };
    expect(finalGalleryFromTrunks([trunk], "running")).toEqual([]);
    expect(
      finalGalleryFromTrunks(
        [
          {
            ...trunk,
            batches: [...trunk.batches, moreWork],
          },
        ],
        "completed",
      ).map((row) => row.itemId),
    ).toEqual([]);
  });

  it("drops the hoisted strip when the assistant text already has pictures", () => {
    const gallery = [
      image("t1:img:0", ".genethub/sessions/s1/images/aa.png"),
      image("t2:img:0", "landscapes/two.png"),
    ];
    expect(galleryNotInMarkdown(gallery, "见图 [two](landscapes/two.png)")).toEqual([]);
    expect(galleryNotInMarkdown(gallery, "画好了。").map((row) => row.itemId)).toEqual([
      "t1:img:0",
      "t2:img:0",
    ]);
    expect(markdownLinkedImagePaths("![a](x.png) and [b](y.webp)")).toEqual(["x.png", "y.webp"]);
  });

  it("recognizes a produced-only batch", () => {
    expect(
      isImageOnlyBatch(batch(0, "t1:img:0", [image("t1:img:0", ".genethub/sessions/s1/images/aa.png")])),
    ).toBe(true);
    expect(
      isImageOnlyBatch(
        batch(0, "t1", [
          { itemId: "t1", kind: "toolCall", overview: "gen" },
          image("t1:img:0", ".genethub/sessions/s1/images/aa.png"),
        ]),
      ),
    ).toBe(false);
  });

  it("drops a hoisted image-only batch and the final-summary monologue", () => {
    const produced = image("t1:img:0", ".genethub/sessions/s1/images/aa.png");
    const batches = [
      batch(0, "t1", [{ itemId: "t1", kind: "toolCall", overview: "gen" }]),
      batch(1, "t1:img:0", [produced]),
      batch(2, "a2", [], { monologue: "画好了。", summary: { text: "画好了。", blobCount: 0 } as never }),
    ];
    batches[2]!.summary = { index: 2, firstItemId: "a2", blobCount: 0, text: "画好了。" };
    const visible = visibleProcessBatches(
      batches,
      "画好了。",
      hoistedImageIds([produced]),
    );
    expect(visible.map((row) => row.summary.firstItemId)).toEqual(["t1"]);
  });

  it("matches a root-qualified preview path to a session thumb", () => {
    const images = inlineImagesFromTrunks([
      {
        summary: { index: 0, firstItemId: "t1", blobCount: 1, title: "画", batches: [] },
        batches: [batch(0, "t1:img:0", [image("t1:img:0", ".genethub/sessions/s1/images/aa.png")])],
      },
    ]);
    expect(images).toHaveLength(1);
    expect(
      thumbForPath(images, "r_repo/.genethub/sessions/s1/images/aa.png"),
    ).toEqual(images[0]);
    expect(thumbDataUrl(images[0]!)).toBe("data:image/jpeg;base64,dGh1bWI=");
  });

  it("rewrites workspace image links to inlined thumbs and leaves other links", () => {
    const images = [
      { path: "landscapes/one.png", mime: "image/jpeg", dataBase64: "dGh1bWI=" },
    ];
    expect(
      rewriteLinkedImagesToThumbs(
        "见图 [one](landscapes/one.png) 和 [文档](docs/readme.md)",
        images,
      ),
    ).toBe("见图 ![one](data:image/jpeg;base64,dGh1bWI=) 和 [文档](docs/readme.md)");
    expect(appendUnlinkedThumbs("画好了。", images)).toBe(
      "画好了。\n![one](data:image/jpeg;base64,dGh1bWI=)",
    );
    expect(isSafeInlineImageDataUrl("data:image/jpeg;base64,dGh1bWI=")).toBe(true);
    expect(isSafeInlineImageDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
  });
});
