import { describe, test, expect } from "bun:test";
import { HeadingLeadParagraphDistiller } from "./bruno-distill";

const SAMPLE = `# Self — Current Self-Model

## Who I Am Right Now

First paragraph of who-I-am, this stays.

Second paragraph, this gets dropped.

Third paragraph, also dropped.

## How I Think

Lead paragraph for how-I-think.

More detail that should not survive distillation.

## Private Section — Full

Lead paragraph of the private section.

This second paragraph of the private section must survive because it is kept full.

Third paragraph of the private section, also must survive.
`;

describe("HeadingLeadParagraphDistiller", () => {
  test("keeps every heading", async () => {
    const distiller = new HeadingLeadParagraphDistiller();
    const out = await distiller.distill(SAMPLE);
    expect(out).toContain("## Who I Am Right Now");
    expect(out).toContain("## How I Think");
    expect(out).toContain("## Private Section — Full");
  });

  test("keeps only the lead paragraph of a normal section", async () => {
    const distiller = new HeadingLeadParagraphDistiller();
    const out = await distiller.distill(SAMPLE);
    expect(out).toContain("First paragraph of who-I-am, this stays.");
    expect(out).not.toContain("Second paragraph, this gets dropped.");
    expect(out).not.toContain("Third paragraph, also dropped.");
    expect(out).toContain("Lead paragraph for how-I-think.");
    expect(out).not.toContain("More detail that should not survive distillation.");
  });

  test("keeps a section in full when its heading matches keepFullHeading", async () => {
    const distiller = new HeadingLeadParagraphDistiller();
    const out = await distiller.distill(SAMPLE, { keepFullHeading: /Private/i });
    expect(out).toContain("Lead paragraph of the private section.");
    expect(out).toContain("This second paragraph of the private section must survive because it is kept full.");
    expect(out).toContain("Third paragraph of the private section, also must survive.");
  });

  test("keeps a section in full when its body carries the keep-full marker", async () => {
    const distiller = new HeadingLeadParagraphDistiller();
    const doc = "## Marked\n\n<!-- distill: keep-full -->\n\nLead.\n\nSecond survives.\n\n## Plain\n\nLead.\n\nSecond dropped.\n";
    const out = await distiller.distill(doc);
    expect(out).toContain("Second survives.");
    expect(out).not.toContain("Second dropped.");
  });

  test("keeps preamble before the first heading in full", async () => {
    const distiller = new HeadingLeadParagraphDistiller();
    const out = await distiller.distill(SAMPLE);
    expect(out).toContain("# Self — Current Self-Model");
  });
});
