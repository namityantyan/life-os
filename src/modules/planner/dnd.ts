// Minimal HTML5 drag-and-drop bookkeeping. dataTransfer.getData is unavailable during dragover,
// so the dragged item id is also kept in module state.
import type { DragEvent } from "react";

let current: string | null = null;
export const MIME = "application/x-lifeos-planner";

export function beginDrag(e: DragEvent, id: string) {
  current = id;
  e.dataTransfer.setData("text/plain", id);
  e.dataTransfer.setData(MIME, id);
  e.dataTransfer.effectAllowed = "move";
}
export function endDrag() { current = null; }
export function isPlannerDrag(e: DragEvent) { return current !== null || e.dataTransfer.types.includes(MIME); }
export function readDragId(e: DragEvent): string | null {
  return e.dataTransfer.getData(MIME) || e.dataTransfer.getData("text/plain") || current;
}
