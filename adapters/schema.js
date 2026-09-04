/**
 * adapters/schema.js - The one Assignment shape every portal maps into.
 *
 * Every adapter (Blackbaud, Canvas, Google Classroom, Mock) returns an array
 * of objects in EXACTLY this shape, so nothing downstream ever cares which
 * school portal the data came from:
 *
 *   {
 *     id:       string   stable id (portal id when available, else a content hash)
 *     title:    string
 *     course:   string
 *     type:     string   "test" | "project" | "essay" | "lab" | "homework" | "reading" | "other"
 *     dueDate:  string   ISO timestamp, or "" if unknown
 *     points:   number   0 if unknown
 *     url:      string   link to open the assignment (Smart Start uses this)
 *     source:   string   "blackbaud" | "canvas" | "classroom" | "mock"
 *     raw:      object   original portal item, kept for debugging
 *   }
 *
 * Loaded as a plain script (content scripts + side panel + service worker
 * all share it), so everything hangs off the global FA namespace.
 */
(() => {
  const FA = (globalThis.FA = globalThis.FA || {});

  /** Tiny stable string hash (djb2) for assignment ids. */
  FA.hashId = function hashId(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return "a" + Math.abs(h).toString(36);
  };

  /** Bucket a portal's free-text assignment type into our canonical types. */
  FA.normalizeType = function normalizeType(text) {
    const t = (text || "").toLowerCase();
    if (/test|exam|quiz|assessment|midterm|final/.test(t)) return "test";
    if (/project|presentation/.test(t)) return "project";
    if (/essay|paper|writing/.test(t)) return "essay";
    if (/lab/.test(t)) return "lab";
    if (/read|annotat|chapter/.test(t)) return "reading";
    if (/homework|\bhw\b|problem|worksheet|practice|assignment/.test(t)) return "homework";
    return "other";
  };

  /** Parse any date-ish string to ISO, or "" if unparseable. */
  FA.toISO = function toISO(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? "" : d.toISOString();
  };

  /**
   * Build a normalized Assignment. Adapters call this instead of
   * hand-rolling objects, so validation lives in one place.
   */
  FA.makeAssignment = function makeAssignment({ id, title, course, type, dueDate, points, url, source, raw }) {
    const safeTitle = title || "(untitled)";
    const iso = FA.toISO(dueDate);
    return {
      // Prefer the portal's own stable id when the adapter has one — two
      // assignments can share a title, course, and due date (e.g. "Homework"
      // twice in the same class), and a content hash would collide.
      id: id ? `${source}-${id}` : FA.hashId(`${source}|${safeTitle}|${course || ""}|${iso}`),
      title: safeTitle,
      course: course || "",
      // Type can come pre-normalized or as portal free text; both work.
      type: ["test", "project", "essay", "lab", "homework", "reading", "other"].includes(type)
        ? type
        : FA.normalizeType(type || safeTitle),
      dueDate: iso,
      points: Number(points) || 0,
      url: url || "",
      source: source || "unknown",
      raw: raw || null,
    };
  };
})();
