import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ReplyThread } from "@oneshot-gtm/shared-types";

/** Scroll only the reader; refreshing data must not move someone reading history. */
export function useReplyScroll(messages: ReplyThread["messages"]) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  const previousIds = useRef<Set<string> | null>(null);
  const following = useRef(true);
  const anchor = useRef<{ element: HTMLElement; offset: number } | null>(null);
  const [newMessage, setNewMessage] = useState(false);
  const latestId = messages.findLast((message) => !message.deleted)?.id;

  const rememberPosition = useCallback(() => {
    const body = bodyRef.current;
    if (!body?.clientHeight) return;
    const viewport = body.getBoundingClientRect();
    const latest = latestRef.current?.getBoundingClientRect();
    // Seeing the beginning of a long message does not mean the reader is caught up.
    following.current =
      !!latest && latest.bottom > viewport.top && latest.bottom <= viewport.bottom + 24;
    const firstVisible = Array.from(
      body.querySelectorAll<HTMLElement>("[data-message-id], [data-reply-composer]"),
    ).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    anchor.current = firstVisible
      ? {
          element: firstVisible,
          offset: firstVisible.getBoundingClientRect().top - viewport.top,
        }
      : null;
    if (following.current) setNewMessage(false);
  }, []);

  const restorePosition = useCallback(() => {
    const body = bodyRef.current;
    const saved = anchor.current;
    if (body && saved && body.contains(saved.element)) {
      body.scrollTop +=
        saved.element.getBoundingClientRect().top - body.getBoundingClientRect().top - saved.offset;
    }
  }, []);

  const isEditing = useCallback(() => {
    return (
      bodyRef.current?.contains(document.activeElement) &&
      document.activeElement?.matches("textarea, input, select, [contenteditable=true]")
    );
  }, []);

  const scrollToLatest = useCallback(() => {
    const body = bodyRef.current;
    const latest = latestRef.current;
    if (!body?.clientHeight) return;
    if (latest) {
      const viewport = body.getBoundingClientRect();
      const message = latest.getBoundingClientRect();
      // Long messages start at their beginning; shorter ones end just above the fold.
      body.scrollTop +=
        message.height > body.clientHeight - 24
          ? message.top - viewport.top - 12
          : message.bottom - viewport.bottom + 12;
    } else {
      body.scrollTop = 0;
    }
    setNewMessage(false);
    rememberPosition();
  }, [rememberPosition]);

  useLayoutEffect(() => {
    const previous = previousIds.current;
    const appended = latestId != null && previous != null && !previous.has(latestId);
    if (
      previous === null ||
      (previous.size === 0 && latestId) ||
      (appended && following.current && !isEditing())
    ) {
      scrollToLatest();
    } else {
      // Preserve a message's visual position when history is prepended or updated.
      restorePosition();
      if (appended) setNewMessage(true);
    }
    previousIds.current = new Set(messages.map((message) => message.id));
    rememberPosition();
  }, [messages, latestId, rememberPosition, restorePosition, scrollToLatest, isEditing]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let width = body.clientWidth;
    let height = body.clientHeight;
    const observer = new ResizeObserver(() => {
      if (!body.clientHeight || (width === body.clientWidth && height === body.clientHeight))
        return;
      width = body.clientWidth;
      height = body.clientHeight;
      if (following.current && !isEditing()) scrollToLatest();
      else restorePosition();
      rememberPosition();
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [isEditing, rememberPosition, restorePosition, scrollToLatest]);

  return { bodyRef, latestRef, onScroll: rememberPosition, scrollToLatest, newMessage };
}
