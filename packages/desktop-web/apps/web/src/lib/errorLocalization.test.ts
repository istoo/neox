import { describe, expect, it } from "vitest";

import {
  localizeLibraryError,
  localizeNetworkError,
  localizeSyncError,
  unwrapRpcMessage,
  type Translator,
} from "./errorLocalization";

const t: Translator = (key, values) =>
  values === undefined ? key : `${key}|${JSON.stringify(values)}`;

describe("errorLocalization", () => {
  it("removes the bridge's request wrapper", () => {
    expect(
      unwrapRpcMessage(
        "Request failed: fatal: unable to access 'https://github.com/not a repo.git/': URL rejected: Malformed input to a URL function requestType=library.skill.find.request code=handler_error",
      ),
    ).toBe(
      "fatal: unable to access 'https://github.com/not a repo.git/': URL rejected: Malformed input to a URL function",
    );
    expect(
      unwrapRpcMessage(
        "Could not read the source: Request failed: socket closed requestType=x code=y",
      ),
    ).toBe("socket closed");
  });

  it("maps the daemon's sync refusals", () => {
    expect(
      localizeSyncError("GitHub sync needs a token with Contents read and write permission", t),
    ).toBe("settings:hostData_syncNeedsGithubToken");
    expect(
      localizeSyncError(
        "the passphrase is the GitHub token: GitHub receives it, and could open the file with it.",
        t,
      ),
    ).toBe("settings:hostData_syncGithubTokenIsPassphrase");
    expect(localizeSyncError("sync needs a passphrase", t)).toBe(
      "settings:hostData_syncNeedsPassphrase",
    );
    expect(localizeSyncError("Some new daemon refusal", t)).toBe("Some new daemon refusal");
  });

  it("maps network and browser-page failures", () => {
    expect(
      localizeNetworkError(
        "The listen address is controlled by NEOLIX_LISTEN. Remove it before changing the port or LAN sharing here.",
        t,
      ),
    ).toBe("settings:host_errorListenControlled");
    expect(
      localizeNetworkError(
        "port 4318 is taken by another program; Neox tries again every few seconds",
        t,
      ),
    ).toBe('settings:host_pageErrorPortTaken|{"port":"4318"}');
    expect(
      localizeNetworkError(
        "port 4318 can't be taken (EACCES); Neox tries again every few seconds",
        t,
      ),
    ).toBe('settings:host_pageErrorPortUnavailable|{"port":"4318","detail":"EACCES"}');
  });

  it("maps library failures after removing the wrapper", () => {
    expect(
      localizeLibraryError(
        "Request failed: ENOENT: no such file or directory, lstat '/tmp/xxx' requestType=library.skill.import.request code=handler_error",
        t,
      ),
    ).toBe('settings:library_errorPathMissing|{"path":"/tmp/xxx"}');
    expect(
      localizeLibraryError(
        "Request failed: fatal: unable to access 'https://github.com/not a repo.git/': URL rejected: Malformed input to a URL function requestType=library.skill.find.request code=handler_error",
        t,
      ),
    ).toBe("settings:library_errorRepository");
    expect(
      localizeLibraryError("Request failed: EACCES: permission denied requestType=x code=y", t),
    ).toBe("settings:library_errorPermission");
  });

  it("keeps an unrecognized reason without the request wrapper", () => {
    expect(
      localizeLibraryError(
        "Request failed: the library refused this name requestType=library.skill.import.request code=handler_error",
        t,
      ),
    ).toBe("the library refused this name");
  });
});
