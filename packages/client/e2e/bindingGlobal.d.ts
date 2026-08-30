// Ambient typing for the global the prebuilt bundle (build-bundle.mjs)
// exposes inside the page — shared by every e2e spec so each doesn't
// redeclare it.
export interface BindingRenderRun {
  readonly textNode: Text;
  startVis: number;
  scalarLen: number;
  utf16Len: number;
}

export interface BindingDomWriter {
  mount(root: Element, text: string): void;
  insertText(visOffset: number, text: string, expectedText?: string): void;
  deleteRange(visOffset: number, count: number, expectedText?: string): void;
  materializedText(): string;
  assertConsistent(expectedOracleText?: string): void;
  assertionsEnabled: boolean;
  readonly index: readonly BindingRenderRun[];
  readonly rootElement: Element | null;
}

declare global {
  interface Window {
    /** Test-only scratch slot a spec can stash a DomWriter instance into, to read back across separate `page.evaluate` calls. */
    __writer?: BindingDomWriter;
    Binding: {
      DomWriter: new () => BindingDomWriter;
      RUN_MAX_SCALARS: number;
      visToDom: (
        index: readonly BindingRenderRun[],
        root: Element,
        v: number,
      ) => { node: Node; offset: number };
      domToVis: (index: readonly BindingRenderRun[], node: Node, offset: number) => number;
      normalizeElementPosition: (
        index: readonly BindingRenderRun[],
        node: Element,
        offset: number,
      ) => number;
      scalarToUtf16: (text: string, scalarOffset: number) => number;
      utf16ToScalar: (text: string, utf16Offset: number) => number;
      isInsideSurrogatePair: (text: string, offset: number) => boolean;
    };
  }
}
