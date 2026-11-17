"use client";
// Results pages: remember the search that was just run (Recent searches). Renders nothing.
import { useEffect, useRef } from "react";
import { recordRecentSearch, searchFromParams } from "../lib/recent-searches";

export default function RecordRecentSearch({ query }: { query: string }) {
  const done = useRef("");
  useEffect(() => {
    if (done.current === query) return;     // once per search (also under React's double effects)
    done.current = query;
    const s = searchFromParams(new URLSearchParams(query));
    if (s) void recordRecentSearch(s);
  }, [query]);
  return null;
}
