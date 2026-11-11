// FILE: setupLanguage.ts
// Purpose: Pin tests to English so assertions are independent of the host locale.
// Layer: Vitest setup
// Depends on: the app i18n singleton.

import { beforeEach } from "vitest";

import { setLanguagePreference } from "../i18n";

// The singleton resolves the "system" preference from navigator.languages at
// import time. Pin the default, and reset before every test because suites
// commonly restore "system" in afterEach. Tests that exercise detection set
// their own preference or stub the navigator inside the test.
setLanguagePreference("en");
beforeEach(() => setLanguagePreference("en"));
