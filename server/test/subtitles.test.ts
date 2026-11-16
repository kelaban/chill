import { describe, expect, it } from "vitest";
import { factsFromName, matchTrack, normalizeLang, parseCues, pickSubtitle, toVtt, type TrackFacts } from "../src/domain/subtitles.js";

describe("languages", () => {
  it.each([
    ["English", "en"], ["eng", "en"], ["en-US", "en"], ["pt-BR", "pt"], ["por", "pt"], ["Español", "es"],
    ["jpn", "ja"], ["kor", "ko"], ["chi", "zh"], ["und", null], ["", null], [null, null],
  ] as const)("%s → %s", (s, code) => expect(normalizeLang(s)).toBe(code));

  it.each([
    ["Sintel.en.srt", { language: "en", forced: false, sdh: false }],
    ["Movie.2023.eng.forced.srt", { language: "en", forced: true, sdh: false }],
    ["2_English.srt", { language: "en", forced: false, sdh: false }],
    ["Movie.English.SDH.srt", { language: "en", forced: false, sdh: true }],
    ["Movie (2019) {tmdb-1} - 1080p.ko.srt", { language: "ko", forced: false, sdh: false }],
    ["Subs/Spanish (Latin).srt", { language: "es", forced: false, sdh: false }],
    ["Movie.en.hi.srt", { language: "en", forced: false, sdh: true }],
    ["Movie.srt", { language: null, forced: false, sdh: false }],
  ] as const)("%s", (name, facts) => expect(factsFromName(name)).toEqual(facts));
});

describe("cues", () => {
  const SRT = "﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nHello <font color=red>there</font>\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,250\r\n{\\an8}<i>Top line</i>\r\n\r\n";
  const VTT = "WEBVTT\n\nNOTE comment\n\n00:01.000 --> 00:02.000 align:start\nShort timestamps\n\n01:00:00.000 --> 01:00:01.500\nOne hour in\n";

  it("parses SRT (BOM, CRLF, markup) and VTT (short timestamps, settings)", () => {
    expect(parseCues(SRT)).toEqual([
      { start: 1.5, end: 3, text: "Hello <font color=red>there</font>" },
      { start: 4, end: 5.25, text: "{\\an8}<i>Top line</i>" },
    ]);
    expect(parseCues(VTT)).toEqual([
      { start: 1, end: 2, text: "Short timestamps" },
      { start: 3600, end: 3601.5, text: "One hour in" },
    ]);
  });

  it("writes WebVTT with a time transform and cleans markup", () => {
    const v = toVtt(parseCues(SRT), { scale: 1, shift: 2.5 });
    expect(v).toBe("WEBVTT\n\n00:00:04.000 --> 00:00:05.500\nHello there\n\n00:00:06.500 --> 00:00:07.750\n<i>Top line</i>\n");
  });

  it("drops cues that end before 0 (compat stream starting mid-film) and clamps starts", () => {
    const v = toVtt(parseCues(SRT), { shift: -2 });
    expect(v).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there\n\n00:00:02.000 --> 00:00:03.250\n<i>Top line</i>\n");
    expect(toVtt(parseCues(SRT), { shift: -10 })).toBe("WEBVTT\n");
  });

  it("applies alignment scale (frame-rate drift)", () => {
    const [c] = parseCues(toVtt([{ start: 1000, end: 1002, text: "x" }], { scale: 1.001, shift: 0.5 }));
    expect(c!.start).toBeCloseTo(1001.5, 3);
  });
});

describe("pickSubtitle", () => {
  const t = (id: string, language: string | null, o: Partial<TrackFacts> = {}): TrackFacts => ({ id, language, forced: false, sdh: false, ...o });
  const tracks = [t("en-sdh", "en", { sdh: true }), t("en", "en"), t("en-forced", "en", { forced: true }), t("es", "es"), t("ko", "ko")];

  it("foreign-language film → full English, non-SDH first", () => {
    expect(pickSubtitle(tracks, { originalLanguage: "ko", preferred: "en" })?.id).toBe("en");
  });
  it("English film → forced English only (foreign-dialogue lines), else none", () => {
    expect(pickSubtitle(tracks, { originalLanguage: "en", preferred: "en" })?.id).toBe("en-forced");
    expect(pickSubtitle(tracks.filter((x) => !x.forced), { originalLanguage: "en", preferred: "en" })).toBeNull();
  });
  it("unknown original language behaves like an English film", () => {
    expect(pickSubtitle(tracks, { originalLanguage: null, preferred: "en" })?.id).toBe("en-forced");
  });
  it("a remembered choice wins, including off", () => {
    expect(pickSubtitle(tracks, { originalLanguage: "ko", preferred: "en", remembered: null })).toBeNull();
    expect(pickSubtitle(tracks, { originalLanguage: "en", preferred: "en", remembered: { language: "es", forced: false, sdh: false } })?.id).toBe("es");
    expect(pickSubtitle(tracks, { originalLanguage: "en", preferred: "en", remembered: { language: "en", forced: false, sdh: true } })?.id).toBe("en-sdh");
  });
  it("foreign film with only forced English falls back to it", () => {
    expect(pickSubtitle([t("f", "en", { forced: true })], { originalLanguage: "ja", preferred: "en" })?.id).toBe("f");
  });
  it("matchTrack finds the equivalent track on another copy", () => {
    expect(matchTrack({ language: "en", forced: false, sdh: true }, tracks)?.id).toBe("en-sdh");
    expect(matchTrack({ language: "en", forced: false, sdh: true }, [t("x", "en")])?.id).toBe("x");
    expect(matchTrack({ language: "fr", forced: false, sdh: false }, tracks)).toBeNull();
  });
});
