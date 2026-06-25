import assert from "node:assert/strict";
import test from "node:test";
import { formatUsdAmount, formatUsdPrice, roundUsdPrice } from "../src/lib/formatters.ts";

test("sub-dollar trade levels retain meaningful precision", () => {
  assert.equal(formatUsdPrice(0.7384), "$0.7384");
  assert.equal(formatUsdPrice(0.731), "$0.7310");
  assert.equal(formatUsdPrice(0.0831), "$0.08310");
});

test("larger token prices retain cent precision", () => {
  assert.equal(formatUsdPrice(593.56), "$593.56");
  assert.equal(formatUsdPrice(64_018.3), "$64,018.30");
});

test("sub-dollar calculated levels are not rounded to cents", () => {
  assert.equal(roundUsdPrice(0.718047), 0.718);
  assert.equal(roundUsdPrice(0.744031), 0.744);
});

test("account dollar amounts use standard cent precision", () => {
  assert.equal(formatUsdAmount(0), "$0.00");
  assert.equal(formatUsdAmount(-2.22), "-$2.22");
});
