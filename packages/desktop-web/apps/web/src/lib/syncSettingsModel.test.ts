import { describe, expect, it } from "vitest";

import { syncUrlForBackend } from "./syncSettingsModel";

describe("syncUrlForBackend", () => {
  it("leaves a WebDAV address as typed", () => {
    expect(syncUrlForBackend("webdav", " https://dav.example.com/neolix ")).toEqual({
      url: "https://dav.example.com/neolix",
    });
  });

  it("gives S3 the scheme the daemon reads", () => {
    expect(syncUrlForBackend("s3", "bucket/prefix")).toEqual({ url: "s3://bucket/prefix" });
    expect(syncUrlForBackend("s3", "s3://bucket/prefix")).toEqual({ url: "s3://bucket/prefix" });
  });

  it("turns a pasted GitHub web address into github://", () => {
    expect(syncUrlForBackend("github", "https://github.com/you/setup")).toEqual({
      url: "github://you/setup",
    });
    expect(syncUrlForBackend("github", "https://github.com/you/setup.git")).toEqual({
      url: "github://you/setup",
    });
  });

  it("reads a branch and path from a GitHub tree address", () => {
    expect(syncUrlForBackend("github", "https://github.com/you/setup/tree/dev/data")).toEqual({
      url: "github://you/setup/data",
      branch: "dev",
    });
  });

  it("leaves github:// addresses and prefixes a bare owner/repo", () => {
    expect(syncUrlForBackend("github", "github://you/setup/prefix")).toEqual({
      url: "github://you/setup/prefix",
    });
    expect(syncUrlForBackend("github", "you/setup/prefix")).toEqual({
      url: "github://you/setup/prefix",
    });
  });
});
