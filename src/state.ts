import * as library from "./lib/library";
import { type LocalSession } from "./lib/idb";

// =============================================================================
// Shared Mutable State
// =============================================================================

export let selectedShelfId: number | null = null;
export function setSelectedShelfId(id: number | null) { selectedShelfId = id; }

export let shelfTree: library.ShelfTree[] = [];
export function setShelfTree(tree: library.ShelfTree[]) { shelfTree = tree; }

export let activeSession: LocalSession | null = null;
export function setActiveSession(session: LocalSession | null) { activeSession = session; }

export let sessionTimerInterval: number | null = null;
export function setSessionTimerInterval(id: number | null) { sessionTimerInterval = id; }

export let currentTextId: number | null = null;
export function setCurrentTextId(id: number | null) { currentTextId = id; }

export let currentShelfTexts: library.TextSummary[] = [];
export function setCurrentShelfTexts(texts: library.TextSummary[]) { currentShelfTexts = texts; }

export let currentTextSegments: library.TextSegment[] = [];
export function setCurrentTextSegments(segments: library.TextSegment[]) { currentTextSegments = segments; }

export let currentTextCharacterCount: number | undefined = undefined;
export function setCurrentTextCharacterCount(count: number | undefined) { currentTextCharacterCount = count; }
