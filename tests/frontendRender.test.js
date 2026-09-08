import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * FRONTEND RENDER CONTRACT
 *
 * Both frontends are static HTML with inline scripts. These tests extract
 * the pure render helpers and exercise them against the exact payload
 * shapes the V2 engines produce, so a regression in rendering is caught
 * without a browser.
 */

/**
 * Extracts ONLY the pure render helpers by source slicing. Executing the
 * whole script block would bootstrap the page, so the helpers are lifted
 * out and evaluated in isolation — no DOM, no network.
 */
function extract(html, startMarker, endMarker) {
  const i = html.indexOf(startMarker);
  assert.ok(i >= 0, `missing ${startMarker}`);
  const j = html.indexOf(endMarker, i);
  assert.ok(j > i, `missing terminator for ${startMarker}`);
  return html.slice(i, j + endMarker.length);
}

function loadHelpers(file) {
  const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const parts = [];

  if (file === "index.html") {
    parts.push("function esc(s){return String(s).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));}");
    parts.push("function evidencePanel(){return '';}");
    parts.push(extract(html, "function statLine(x){", "\n}"));
    parts.push(extract(html, "const VERDICT_MEANING={", "};"));
    parts.push(extract(html, "function councilBlock(d,news){", "\n}"));
    parts.push("return { statLine, VERDICT_MEANING, councilBlock, esc };");
  } else {
    parts.push(extract(html, "function escapeHtml(s){", "\n}"));
    parts.push(extract(html, "function statLine(h){", "\n}"));
    parts.push(extract(html, "const VERDICT_MEANING = {", "};"));
    parts.push("return { statLine, VERDICT_MEANING, escapeHtml };");
  }
  return new Function(parts.join("\n"))();
}

const web = loadHelpers("index.html");
const premium = loadHelpers("horseman-preview.html");
const ALL_VERDICTS = ["REJECT", "WATCH", "WAIT", "FAVOURABLE", "STRONG", "EXCEPTIONAL"];

/* ---------------- verdict vocabulary ---------------- */

test("both frontends explain every one of the six verdicts", () => {
  for (const ui of [web, premium]) {
    for (const v of ALL_VERDICTS) {
      assert.ok(ui.VERDICT_MEANING[v], `${v} has no explanation`);
      assert.ok(ui.VERDICT_MEANING[v].length > 20, `${v}'s explanation is too thin to help anyone`);
    }
    assert.equal(Object.keys(ui.VERDICT_MEANING).length, 6, "exactly the six canonical verdicts");
  }
});

test("WAIT and EXCEPTIONAL are rendered meaningfully, not as bare words", () => {
  for (const ui of [web, premium]) {
    assert.match(ui.VERDICT_MEANING.WAIT, /not yet complete or strong enough/);
    assert.match(ui.VERDICT_MEANING.WAIT, /Waiting is the safer choice/);
    assert.match(ui.VERDICT_MEANING.EXCEPTIONAL, /unusually strong, complete/);
  }
});

test("WAIT is distinguishable from WATCH in plain language", () => {
  for (const ui of [web, premium]) {
    assert.notEqual(ui.VERDICT_MEANING.WAIT, ui.VERDICT_MEANING.WATCH);
    assert.match(ui.VERDICT_MEANING.WATCH, /balanced/);
    assert.match(ui.VERDICT_MEANING.WAIT, /promising/);
  }
});

test("no verdict is described as a prediction or a guarantee", () => {
  for (const ui of [web, premium]) {
    for (const v of ALL_VERDICTS) {
      const text = ui.VERDICT_MEANING[v].toLowerCase();
      for (const banned of ["will rise", "will fall", "guarantee", "profit",
                            "probability", "expect", "predict"]) {
        assert.ok(!text.includes(banned), `${v} must not promise ${banned}`);
      }
    }
  }
});

/* ---------------- null directional state ---------------- */

const conquestV2 = {
  name: "CONQUEST", direction: null, confidence: null,
  dataSource: { engine: "v2", crowdSentiment: "UNKNOWN", behaviouralRegimes: ["RISING_PARTICIPATION"] },
};
const deathV2 = {
  name: "DEATH", direction: null, confidence: null,
  dataSource: { engine: "v2", riskSeverity: "MODERATE", evidenceConfidence: "STRONG" },
};
const legacyHorseman = { name: "WAR", direction: "BULLISH", confidence: 83 };

test("REGRESSION: a null direction never renders as 'null' or a fabricated percentage", () => {
  for (const ui of [web, premium]) {
    for (const h of [conquestV2, deathV2]) {
      const line = ui.statLine(h);
      assert.ok(!/null/i.test(line), `"${line}" must not contain null`);
      assert.ok(!/undefined/i.test(line));
      assert.ok(!/\bNaN\b/.test(line));
      assert.ok(!/—\s*%|·\s*%/.test(line), "no empty percentage");
      assert.ok(line.length > 0);
    }
  }
});

test("Conquest V2 is described as behaviour observed with no crowd view", () => {
  for (const ui of [web, premium]) {
    const line = ui.statLine(conquestV2);
    assert.match(line, /Behaviour observed/);
    assert.match(line, /no crowd view available/);
    // It must not imply a market direction.
    for (const banned of ["BULLISH", "BEARISH", "NEUTRAL"]) {
      assert.ok(!line.includes(banned), `${banned} must not appear`);
    }
  }
});

test("Death V2 shows risk severity and evidence confidence, not a direction", () => {
  for (const ui of [web, premium]) {
    const line = ui.statLine(deathV2);
    assert.match(line, /Risk: moderate/);
    assert.match(line, /evidence strong/);
    assert.ok(!/BULLISH|BEARISH/.test(line));
  }
});

test("a Horseman that reports UNKNOWN is shown as reaching no view", () => {
  for (const ui of [web, premium]) {
    const line = ui.statLine({ name: "FAMINE", direction: "UNKNOWN", confidence: null });
    assert.match(line, /No directional view reached/);
    assert.ok(!/UNKNOWN\s*[—·]/.test(line), "UNKNOWN is not shown as a stance with a score");
  }
});

test("legacy Horsemen render exactly as before", () => {
  assert.match(web.statLine(legacyHorseman), /BULLISH · 83%/);
  assert.match(premium.statLine(legacyHorseman), /BULLISH — 83%/);
});

/* ---------------- no verdict ---------------- */

const noVerdict = {
  engine: "v2", status: "INTEGRATION_UNAVAILABLE", verdict: null, confidence: null,
  missingDependencies: ["CONQUEST_V2"],
  reasons: ["Council V2 requires CONQUEST_V2, which is not yet wired into the live analysis route."],
  limitations: ["The legacy Evidence Engine is deliberately not consumed by Council V2."],
};

test("REGRESSION: no verdict renders as no verdict, with no confidence figure", () => {
  const html = web.councilBlock({ council: noVerdict, evidenceEngine: null }, "");
  assert.match(html, /NO VERDICT/);
  assert.match(html, /No verdict reached/);
  assert.ok(!/null/i.test(html), "null must never reach the page");
  assert.ok(!/\d+% confidence/.test(html), "no confidence figure may be shown");
  assert.match(html, /not a neutral result/);
  assert.match(html, /CONQUEST_V2/, "the missing evidence is named");
});

test("the premium frontend also renders the no-verdict state honestly", () => {
  const html = readFileSync(new URL("../horseman-preview.html", import.meta.url), "utf8");
  assert.match(html, /The Council Reached No Verdict/);
  assert.match(html, /no confidence figure, because no verdict was reached/);
  assert.match(html, /not a neutral result and must not be read as one/);
  assert.match(html, /Evidence the Council still needs/);
});

test("a legacy verdict still renders normally", () => {
  const html = web.councilBlock({
    council: { verdict: "FAVOURABLE", confidence: 72, synopsis: "A synopsis.",
      reasons: ["r1"], changeMind: ["c1"] },
    evidenceEngine: null }, "");
  assert.match(html, /FAVOURABLE · 72% confidence/);
  assert.match(html, /The evidence supports the case/);
  assert.match(html, /A synopsis\./);
  assert.match(html, /r1/);
  assert.match(html, /c1/);
});

test("a V2 verdict renders with its meaning, coverage and abstentions", () => {
  const html = web.councilBlock({
    council: {
      engine: "v2", status: "ASSESSED", verdict: "WAIT", confidence: 46,
      coverage: { participating: ["WAR", "FAMINE"], abstained: ["CONQUEST"] },
      verdictReasons: ["Evidence strength 0.65 is below the floor."],
      whatWouldChangeMind: ["A directional conclusion from CONQUEST."],
    }, evidenceEngine: null }, "");
  assert.match(html, /WAIT · 46% confidence/);
  assert.match(html, /Waiting is the safer choice/);
  assert.match(html, /Reached no view: CONQUEST/);
  assert.match(html, /an abstention is not agreement/);
  assert.match(html, /Evidence strength 0\.65/);
  assert.match(html, /A directional conclusion from CONQUEST/);
});

test("an abstention is never presented as agreement or as a neutral vote", () => {
  const html = web.councilBlock({
    council: { verdict: "FAVOURABLE", confidence: 55,
      coverage: { participating: ["WAR", "FAMINE"], abstained: ["CONQUEST"] } },
    evidenceEngine: null }, "");
  assert.match(html, /an abstention is not agreement/);
  assert.ok(!/CONQUEST[^<]*NEUTRAL/.test(html));
});

/* ---------------- no fabrication ---------------- */

test("neither frontend invents a direction, score or verdict", () => {
  for (const file of ["index.html", "horseman-preview.html"]) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    // No default/fallback stance or score anywhere in the render path.
    for (const banned of ['direction || "NEUTRAL"', 'confidence || 50', 'verdict || "WATCH"',
                          '?? "NEUTRAL"', '?? 50']) {
      assert.ok(!html.includes(banned), `${file} must not fabricate with ${banned}`);
    }
  }
});

test("the frontends compute no verdict logic of their own", () => {
  for (const file of ["index.html", "horseman-preview.html"]) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const banned of ["evidenceStrength >", "confidence >", "score >=", "riskSeverity ==="]) {
      assert.ok(!html.includes(banned), `${file} must not re-derive judgment`);
    }
  }
});

/* ==================================================================== */
/* V2 ACTIVATION + THE ESCAPING DEFECT                                   */
/*                                                                       */
/* The earlier tests in this file extracted helpers and regex-matched     */
/* source text. That is exactly why a live rendering defect shipped with  */
/* a green suite: the html`` tagged template was never executed, so the   */
/* escaping path was never exercised. These tests run it for real.        */
/* ==================================================================== */

/** The preview's ACTUAL rendering primitives, lifted from the shipped file. */
function loadTemplateEngine() {
  const html = readFileSync(new URL("../horseman-preview.html", import.meta.url), "utf8");
  const src = [
    extract(html, "function escapeHtml(s){", "\n}"),
    extract(html, "function safe(v){", "\n}"),
    extract(html, "function html(strings, ...vals){", "\n}"),
    "return { html, safe, escapeHtml };",
  ].join("\n");
  return new Function(src)();
}

/** The verdict-confidence expression exactly as it appears in the file. */
function verdictConfidenceMarkup() {
  const file = readFileSync(new URL("../horseman-preview.html", import.meta.url), "utf8");
  return extract(file, '<div class="verdict-confidence">', "</div>");
}

test("REGRESSION: the confidence markup RENDERS, it does not escape", () => {
  const { html, safe, escapeHtml } = loadTemplateEngine();
  const markup = verdictConfidenceMarkup();
  // Evaluate the real expression from the file against the real engine.
  const render = new Function("html", "safe", "escapeHtml", "council",
    "return html`" + markup + "`;");

  const withVerdict = render(html, safe, escapeHtml, { verdict: "FAVOURABLE", confidence: 53 });
  assert.ok(!withVerdict.includes("&lt;span"),
    `raw HTML was escaped and would display literally: ${withVerdict}`);
  assert.match(withVerdict, /<span class="num">53%<\/span> confidence/);

  const noVerdict = render(html, safe, escapeHtml, { verdict: null, confidence: null });
  assert.ok(!noVerdict.includes("&lt;span"));
  assert.match(noVerdict, /no confidence figure, because no verdict was reached/);
  assert.ok(!/\bnull\b/.test(noVerdict));
});

test("escaping is not weakened: the interpolated value itself is still escaped", () => {
  const { html, safe, escapeHtml } = loadTemplateEngine();
  // A hostile value must not become markup.
  const out = html`<p>${'<img src=x onerror=alert(1)>'}</p>`;
  assert.ok(out.includes("&lt;img"), "plain interpolation must still escape");
  assert.ok(!out.includes("<img"));
  // And escapeHtml is applied to the confidence value inside the safe block.
  const markup = verdictConfidenceMarkup();
  assert.match(markup, /escapeHtml\(council\.confidence\)/,
    "the value must stay escaped even though the surrounding markup is safe");
});

/* ---------------- V2 activation ---------------- */

test("the user-facing preview explicitly requests the V2 engines", () => {
  const file = readFileSync(new URL("../horseman-preview.html", import.meta.url), "utf8");
  for (const engine of ["warEngine", "famineEngine", "conquestEngine", "deathEngine", "councilEngine"]) {
    assert.ok(new RegExp(`searchParams\\.set\\('${engine}', 'v2'\\)`).test(file),
      `the preview must request ${engine}=v2`);
  }
  assert.match(file, /searchParams\.set\('ticker'/);
});

test("activation is client-side only: the API keeps its own defaults", () => {
  const api = readFileSync(new URL("../api/analyse.js", import.meta.url), "utf8");
  // Opt-in gates unchanged for the four engines that default to legacy.
  for (const engine of ["famineEngine", "councilEngine", "deathEngine", "conquestEngine"]) {
    assert.ok(new RegExp(`${engine}\\|\\|''\\)\\.trim\\(\\)\\.toLowerCase\\(\\)==='v2'`).test(api),
      `${engine} must remain opt-in at the API`);
  }
  // War's existing default is likewise untouched.
  assert.ok(/warEngine\|\|''\)\.trim\(\)\.toLowerCase\(\)!=='v1'/.test(api));
});

/* ---------------- developer panel ---------------- */

test("the developer provenance panel is hidden from normal users", () => {
  const file = readFileSync(new URL("../horseman-preview.html", import.meta.url), "utf8");
  assert.match(file, /if \(!isDeveloperView\(\)\) return "";/,
    "the panel must be gated");
  const gate = new Function(extract(file, "function isDeveloperView(){", "\n}") +
    "return isDeveloperView;")();
  for (const [search, expected] of [["", false], ["?ticker=AAPL", false],
                                    ["?debug=1", true], ["?dev=1", true], ["?debug=0", false]]) {
    global.window = { location: { search } };
    assert.equal(gate(), expected, `search "${search}" should be ${expected}`);
  }
  delete global.window;
});

test("gating the panel removes nothing from the API response", () => {
  const api = readFileSync(new URL("../api/analyse.js", import.meta.url), "utf8");
  for (const field of ["dataStatus", "candlesUsed", "latestDataTimestamp", "calculationVersion"]) {
    assert.ok(api.includes(field), `${field} must still be returned by the API`);
  }
});
