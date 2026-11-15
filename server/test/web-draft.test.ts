import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearSentAttachments,
  clearSentText,
  keepSelectedWork,
} from "../../web/src/draft";

const photo = { name: "foto.png", data: "AAAA" };

test("a late reply clears only the draft that was submitted", () => {
  const sent = { workId: undefined, text: "Armá una propuesta", attachments: [] };
  assert.equal(clearSentText("Armá una propuesta", sent), "");
  assert.equal(
    clearSentText("Armá una propuesta y sumá Brasil", sent),
    "Armá una propuesta y sumá Brasil",
  );
});

test("a late reply keeps the attachments the user edited meanwhile", () => {
  const sent = { workId: undefined, text: "x", attachments: [photo] };
  assert.deepEqual(clearSentAttachments(sent.attachments, sent), []);
  const edited = [photo, { name: "otra.pdf", data: "BBBB" }];
  assert.equal(clearSentAttachments(edited, sent), edited);
});

test("a late reply does not switch the work the user opened", () => {
  const sent = { workId: undefined, text: "x", attachments: [] };
  assert.equal(keepSelectedWork(undefined, sent, "work-new"), "work-new");
  assert.equal(keepSelectedWork("work-other", sent, "work-new"), "work-other");
  const existing = { workId: "work-1", text: "x", attachments: [] };
  assert.equal(keepSelectedWork("work-1", existing, "work-1"), "work-1");
});
