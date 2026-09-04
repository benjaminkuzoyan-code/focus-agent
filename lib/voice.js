/**
 * lib/voice.js - The student's writing voice: samples → profile → every
 * writing prompt. Everything on-device in chrome.storage.local:
 *
 *   voiceSamples  [{id, title, text, words, source: "paste"|"file"|"gdoc"|"drive"|"auto"|"guide", addedAt}]
 *   voiceGuide    { text, source, importedAt }        explicit rules (e.g. the /essay skill's style guide)
 *   voiceProfile  { profile, traits[], avoid[], builtAt, sampleIds[], fromClaude }
 *
 * FA.voice.forBrain() is what writing prompts receive: the profile, the
 * guide (capped) and a few excerpts — enough for the model to sound like the
 * student, small enough to ride along on every call.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});
  const SAMPLE_CAP = 20000;
  const MAX_SAMPLES = 25;

  const words = (t) => String(t || "").trim().split(/\s+/).filter(Boolean).length;

  async function get(k, fb) {
    const o = await chrome.storage.local.get(k);
    return o[k] ?? fb;
  }

  /** Rules-only profile: measurable habits, no model needed. */
  function statsProfile(samples) {
    const text = samples.map((s) => s.text).join("\n\n");
    if (!text.trim()) return null;
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.split(/\s+/).length > 2);
    const w = text.split(/\s+/).filter(Boolean);
    const avgSent = sentences.length ? Math.round(w.length / sentences.length) : 0;
    const avgWord = w.length ? (w.reduce((a, x) => a + x.replace(/[^A-Za-z]/g, "").length, 0) / w.length).toFixed(1) : 0;
    const contractions = (text.match(/\b\w+'(t|s|re|ve|ll|d|m)\b/gi) || []).length;
    const firstPerson = (text.match(/\b(I|my|me|we|our)\b/g) || []).length;
    const semis = (text.match(/;/g) || []).length;
    const dashes = (text.match(/—|--/g) || []).length;
    const oxford = (text.match(/, and\b/g) || []).length;
    const transitions = {};
    for (const m of text.matchAll(/\b(however|therefore|moreover|consequently|although|because|while|furthermore|in addition|for example|as a result|ultimately|overall)\b/gi)) {
      const k = m[1].toLowerCase();
      transitions[k] = (transitions[k] || 0) + 1;
    }
    const topTrans = Object.entries(transitions).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    const traits = [
      `sentences average ${avgSent} words`,
      `average word length ${avgWord} letters`,
      contractions / Math.max(sentences.length, 1) > 0.15 ? "uses contractions freely" : "rarely uses contractions",
      firstPerson / Math.max(w.length, 1) > 0.02 ? "first person is common" : "mostly third person",
      semis > sentences.length * 0.05 ? "likes semicolons" : "few semicolons",
      dashes === 0 ? "never uses em dashes" : "uses dashes",
      oxford ? "sometimes uses the Oxford comma" : "no Oxford comma",
      topTrans.length ? `favorite transitions: ${topTrans.join(", ")}` : "few explicit transitions",
    ];
    return {
      profile: `Writes ${avgSent}-word sentences on average with ${avgWord}-letter words; ${traits.slice(2, 6).join("; ")}.`,
      traits,
      avoid: ["em dashes", "AI-sounding openers ('In today's world', 'Ultimately')", "lists of three adjectives", "hedging filler"],
      builtAt: Date.now(),
      sampleIds: samples.map((s) => s.id),
      fromClaude: false,
    };
  }

  FA.voice = {
    async samples() {
      return get("voiceSamples", []);
    },
    async guide() {
      return get("voiceGuide", null);
    },
    async profile() {
      return get("voiceProfile", null);
    },

    /** Add one sample; dedupes by text prefix; caps count and length. Returns the sample or null. */
    async addSample({ title, text, source = "paste" }) {
      const clean = String(text || "").trim().slice(0, SAMPLE_CAP);
      if (words(clean) < 80) return null; // too short to say anything about voice
      const list = await this.samples();
      const key = clean.slice(0, 300);
      if (list.some((s) => s.text.slice(0, 300) === key)) return null;
      const s = { id: "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: String(title || "untitled").slice(0, 120), text: clean, words: words(clean), source, addedAt: Date.now() };
      list.push(s);
      while (list.length > MAX_SAMPLES) list.shift();
      await chrome.storage.local.set({ voiceSamples: list });
      return s;
    },
    async removeSample(id) {
      const list = (await this.samples()).filter((s) => s.id !== id);
      await chrome.storage.local.set({ voiceSamples: list });
    },
    async setGuide(text, source = "import") {
      const t = String(text || "").trim().slice(0, 12000);
      if (!t) return null;
      const g = { text: t, source, importedAt: Date.now() };
      await chrome.storage.local.set({ voiceGuide: g });
      return g;
    },

    /**
     * Rebuild the profile: the brain when available (reads real prose), the
     * stats profile otherwise. Called automatically when samples change.
     */
    async rebuild() {
      const samples = await this.samples();
      const guide = await this.guide();
      if (!samples.length && !guide) {
        await chrome.storage.local.remove("voiceProfile");
        return null;
      }
      let prof = null;
      if (FA.coach?.voiceProfile && FA.coachBrain === "claude" && samples.length) {
        try {
          prof = await FA.coach.voiceProfile(samples, guide?.text || "");
        } catch {
          prof = null;
        }
      }
      if (!prof) prof = statsProfile(samples) || { profile: "", traits: [], avoid: [], builtAt: Date.now(), sampleIds: [], fromClaude: false };
      await chrome.storage.local.set({ voiceProfile: prof });
      return prof;
    },

    /** Compact voice package for writing prompts. null when nothing is known. */
    async forBrain() {
      const [samples, guide, profile] = await Promise.all([this.samples(), this.guide(), this.profile()]);
      if (!samples.length && !guide) return null;
      // Excerpts: the start of the 3 most recent samples — openings carry voice.
      const excerpts = samples.slice(-3).map((s) => ({ title: s.title, text: s.text.slice(0, 700) }));
      return {
        profile: profile?.profile || "",
        traits: profile?.traits || [],
        avoid: profile?.avoid || [],
        guide: guide ? guide.text.slice(0, 3500) : "",
        excerpts,
        sampleCount: samples.length,
      };
    },
  };
})();
