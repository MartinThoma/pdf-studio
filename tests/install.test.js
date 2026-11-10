import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPlatform } from "../src/install.js";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  firefoxAndroid: "Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
};

test("detectPlatform picks the install steps for each browser", () => {
  assert.equal(detectPlatform(UA.iphone, 5), "ios");
  assert.equal(detectPlatform(UA.ipad, 5), "ios", "iPadOS reports itself as a Mac with touch");
  assert.equal(detectPlatform(UA.macSafari, 0), "mac-safari");
  assert.equal(detectPlatform(UA.macChrome, 0), "chromium");
  assert.equal(detectPlatform(UA.edge, 0), "chromium");
  assert.equal(detectPlatform(UA.firefoxLinux, 0), "firefox");
  assert.equal(detectPlatform(UA.firefoxAndroid, 5), "firefox-android");
  assert.equal(detectPlatform(UA.chromeAndroid, 5), "chromium");
});
