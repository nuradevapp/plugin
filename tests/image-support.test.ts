import { describe, it, expect } from "bun:test"
import { extFor, formatAttachmentRef, saveAttachment, ATTACH_DIR } from "../src/attachments.js"
import { existsSync, readFileSync, rmSync } from "fs"

describe("extFor", () => {
  it("maps known image media types", () => {
    expect(extFor("image/jpeg")).toBe("jpg")
    expect(extFor("image/png")).toBe("png")
    expect(extFor("image/webp")).toBe("webp")
  })

  it("maps known file media types", () => {
    expect(extFor("application/pdf")).toBe("pdf")
    expect(extFor("text/plain")).toBe("txt")
    expect(extFor("application/json")).toBe("json")
  })

  it("falls back to filename extension when media type unknown", () => {
    expect(extFor("application/x-weird", "report.docx")).toBe("docx")
    expect(extFor("application/octet-stream", "archive.tar.gz")).toBe("gz")
  })

  it("returns 'bin' when nothing else identifies the file", () => {
    expect(extFor("application/x-weird")).toBe("bin")
    expect(extFor("application/x-weird", "noext")).toBe("bin")
  })
})

describe("formatAttachmentRef", () => {
  it("prepends image marker line above text", () => {
    const result = formatAttachmentRef("describe this", "image", "/tmp/x/abc.jpg")
    expect(result).toBe("[image attached: /tmp/x/abc.jpg]\ndescribe this")
  })

  it("prepends file marker line above text", () => {
    const result = formatAttachmentRef("summarise", "file", "/tmp/x/y.pdf", "report.pdf")
    expect(result).toBe("[file attached: report.pdf → /tmp/x/y.pdf]\nsummarise")
  })

  it("returns just the marker when text is empty", () => {
    const result = formatAttachmentRef("", "image", "/tmp/x/abc.png")
    expect(result).toBe("[image attached: /tmp/x/abc.png]")
  })

  it("uses 'unnamed' when file name not provided", () => {
    const result = formatAttachmentRef("hi", "file", "/tmp/x/y.bin")
    expect(result).toBe("[file attached: unnamed → /tmp/x/y.bin]\nhi")
  })
})

describe("saveAttachment", () => {
  it("writes base64 content to /tmp/nuradev-attachments and returns the path", () => {
    const data = Buffer.from("hello world").toString("base64")
    const path = saveAttachment(data, "text/plain")
    expect(path.startsWith(`${ATTACH_DIR}/`)).toBe(true)
    expect(path.endsWith(".txt")).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf-8")).toBe("hello world")
    rmSync(path)
  })

  it("uses the right extension for images", () => {
    const data = Buffer.from([0xff, 0xd8, 0xff]).toString("base64")
    const path = saveAttachment(data, "image/jpeg")
    expect(path.endsWith(".jpg")).toBe(true)
    rmSync(path)
  })
})
