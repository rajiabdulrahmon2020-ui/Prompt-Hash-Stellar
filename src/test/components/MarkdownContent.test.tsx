/**
 * Sensitive-content boundary tests for the prompt renderer.
 *
 * Prompt copy is untrusted input (created by third-party sellers, editable
 * after purchase). These tests prove it cannot execute script, escape the
 * sanitizer's tag/attribute sandbox, or leak into unescaped URL protocols.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MarkdownContent } from "@/components/MarkdownContent";

declare global {
  interface Window {
    __xssExecuted?: boolean;
    __imgExecuted?: boolean;
    __handlerExecuted?: boolean;
  }
}

function renderMarkdown(markdown: string) {
  return render(<MarkdownContent>{markdown}</MarkdownContent>);
}

afterEach(() => {
  cleanup();
  delete window.__xssExecuted;
  delete window.__imgExecuted;
  delete window.__handlerExecuted;
});

describe("MarkdownContent — rendering boundary", () => {
  it("renders ordinary markdown without over-sanitizing", () => {
    const { container } = renderMarkdown(
      "# Heading\n\nSome **bold** text and `inline code`.\n\n- one\n- two\n",
    );

    expect(container.querySelector("h1")?.textContent).toBe("Heading");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("inline code");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("never creates script elements or executes inline scripts", () => {
    const { container } = renderMarkdown(
      "before <script>window.__xssExecuted = true</script> after",
    );

    expect(container.querySelector("script")).toBeNull();
    expect(window.__xssExecuted).toBeUndefined();
  });

  it("strips event-handler attributes from embedded HTML and markdown", () => {
    const { container } = renderMarkdown(
      '<img src="https://example.com/p.png" onerror="window.__imgExecuted = true" alt="x">\n\n' +
        '<a href="https://example.com" onmouseover="window.__handlerExecuted = true">link</a>',
    );

    // Raw HTML is escaped by react-markdown and the sanitizer strips handler
    // attributes — either way, no element may carry an event handler.
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container.querySelector("[onmouseover]")).toBeNull();
    expect(container.querySelector("[onclick]")).toBeNull();
    expect(window.__imgExecuted).toBeUndefined();
    expect(window.__handlerExecuted).toBeUndefined();
  });

  it("removes javascript: and data: protocol URLs", () => {
    const { container } = renderMarkdown(
      "[click me](javascript:alert(1))\n\n![pixel](data:image/svg+xml;base64,PHN2Zz4=)\n\n" +
        "[data link](data:text/html,<script>alert(1)</script>)",
    );

    for (const anchor of Array.from(container.querySelectorAll("a"))) {
      const href = anchor.getAttribute("href") ?? "";
      expect(href.toLowerCase()).not.toContain("javascript:");
      expect(href.toLowerCase()).not.toContain("data:");
    }
    const img = container.querySelector("img");
    if (img) {
      expect((img.getAttribute("src") ?? "").toLowerCase()).not.toMatch(
        /^(javascript|data):/,
      );
    }
  });

  it("strips sandbox-escape tags: iframe, object, embed, form, svg", () => {
    const { container } = renderMarkdown(
      '<iframe src="https://evil.example"></iframe>\n' +
        '<object data="https://evil.example"></object>\n' +
        '<embed src="https://evil.example">\n' +
        '<form action="https://evil.example"><input name="x"></form>\n' +
        '<svg onload="window.__xssExecuted = true"><circle /></svg>',
    );

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("object")).toBeNull();
    expect(container.querySelector("embed")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(window.__xssExecuted).toBeUndefined();
  });

  it("strips style attributes that could smuggle url() payloads", () => {
    const { container } = renderMarkdown(
      '<div style="background:url(javascript:alert(1))">styled</div>',
    );

    for (const element of Array.from(container.querySelectorAll("*"))) {
      expect(element.getAttribute("style") ?? "").not.toContain("javascript:");
    }
  });

  it("hardens external links with target and rel so rendered content cannot take over the opener", () => {
    const { container } = renderMarkdown(
      "[external](https://example.com/page)",
    );

    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com/page");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
