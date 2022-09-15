/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness.js';
import type { Quill } from 'quill';
import type { Store } from './store';

interface AwarenessState {
  user: {
    name: string;
    color: string;
  };
  cursor: {
    anchor: any;
    head: any;
  };
}

/** Removes the pending '\n's if it has no attributes */
export const normQuillDelta = (delta: any) => {
  if (delta.length > 0) {
    const d = delta[delta.length - 1];
    const insert = d.insert;
    if (
      d.attributes === undefined &&
      insert !== undefined &&
      insert.slice(-1) === '\n'
    ) {
      delta = delta.slice();
      let ins = insert.slice(0, -1);
      while (ins.slice(-1) === '\n') {
        ins = ins.slice(0, -1);
      }
      delta[delta.length - 1] = { insert: ins };
      if (ins.length === 0) {
        delta.pop();
      }
      return delta;
    }
  }
  return delta;
};

const updateCursor = (
  quillCursors: any,
  aw: AwarenessState,
  clientId: number,
  doc: Y.Doc,
  yText: Y.Text
) => {
  try {
    if (aw && aw.cursor && clientId !== doc.clientID) {
      const user = aw.user || {};
      const color = user.color || '#ffa500';
      const name = user.name || `User: ${clientId}`;
      quillCursors.createCursor(clientId.toString(), name, color);
      const anchor = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(aw.cursor.anchor),
        doc
      );
      const head = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(aw.cursor.head),
        doc
      );
      if (anchor && head && anchor.type === yText) {
        quillCursors.moveCursor(clientId.toString(), {
          index: anchor.index,
          length: head.index - anchor.index,
        });
      }
    } else {
      quillCursors.removeCursor(clientId.toString());
    }
  } catch (err) {
    console.error(err);
  }
};

export class TextBinding {
  readonly store: Store;
  readonly doc: Y.Doc;
  readonly yText: Y.Text;
  readonly quill: Quill;
  readonly quillCursors: any;
  readonly awareness: Awareness;
  private _negatedUsedFormats: Record<string, any>;

  constructor(store: Store, yText: Y.Text, quill: Quill) {
    this.store = store;
    this.yText = yText;
    this.doc = store.doc;
    this.quill = quill;

    const awareness = store.provider.awareness;
    const quillCursors = quill.getModule('cursors') || null;
    this.quillCursors = quillCursors;
    // This object contains all attributes used in the quill instance
    this._negatedUsedFormats = {};
    this.awareness = awareness;

    this.store.slots.updateText.on(event => {
      this._yObserver(event);
    });

    quill.on('editor-change', this._quillObserver as any);
    // This indirectly initializes _negatedUsedFormats.
    // Make sure that this call this after the _quillObserver is set.
    quill.setContents(yText.toDelta(), this as any);

    // init remote cursors
    if (quillCursors !== null && awareness) {
      awareness.getStates().forEach((aw, clientId) => {
        updateCursor(
          quillCursors,
          aw as AwarenessState,
          clientId,
          store.doc,
          yText
        );
      });
      awareness.on('change', this._awarenessChange);
    }
  }

  private _yObserver = (event: Y.YTextEvent) => {
    if (event.transaction.origin !== this.doc.clientID) {
      const eventDelta = event.delta;
      // We always explicitly set attributes, otherwise concurrent edits may
      // result in quill assuming that a text insertion shall inherit existing
      // attributes.
      const delta: any = [];
      for (let i = 0; i < eventDelta.length; i++) {
        const d = eventDelta[i];
        if (d.insert !== undefined) {
          delta.push(
            Object.assign({}, d, {
              attributes: Object.assign(
                {},
                this._negatedUsedFormats,
                d.attributes || {}
              ),
            })
          );
        } else {
          delta.push(d);
        }
      }
      this.quill.updateContents(delta, this.doc.clientID as any);
    }
  };

  private _quillObserver = (
    _: string,
    delta: any,
    _state: AwarenessState,
    origin: any
  ) => {
    const { awareness, quill, quillCursors, yText, doc } = this;

    if (delta && delta.ops) {
      // update content
      const ops = delta.ops;
      ops.forEach((op: any) => {
        if (op.attributes !== undefined) {
          for (const key in op.attributes) {
            if (this._negatedUsedFormats[key] === undefined) {
              this._negatedUsedFormats[key] = false;
            }
          }
        }
      });
      if (origin === 'user') {
        this.store.transact(() => {
          yText.applyDelta(ops);
        });
      }
    }

    // always check selection
    if (awareness && quillCursors) {
      const sel = quill.getSelection();
      const aw = awareness.getLocalState();
      if (sel === null) {
        if (awareness.getLocalState() !== null) {
          awareness.setLocalStateField('cursor', null);
        }
      } else {
        const anchor = Y.createRelativePositionFromTypeIndex(yText, sel.index);
        const head = Y.createRelativePositionFromTypeIndex(
          yText,
          sel.index + sel.length
        );
        if (
          !aw ||
          !aw.cursor ||
          !Y.compareRelativePositions(anchor, aw.cursor.anchor) ||
          !Y.compareRelativePositions(head, aw.cursor.head)
        ) {
          awareness.setLocalStateField('cursor', {
            anchor,
            head,
          });
        }
      }
      // update all remote cursor locations
      awareness.getStates().forEach((aw, clientId) => {
        updateCursor(quillCursors, aw as any, clientId, doc, yText);
      });
    }
  };

  private _awarenessChange = (diff: {
    added: number[];
    removed: number[];
    updated: number[];
  }) => {
    const { doc, yText } = this;
    const { added, removed, updated } = diff;

    const states = this.awareness.getStates();
    added.forEach(id => {
      updateCursor(
        this.quillCursors,
        states.get(id) as AwarenessState,
        id,
        doc,
        yText
      );
    });
    updated.forEach(id => {
      updateCursor(
        this.quillCursors,
        states.get(id) as AwarenessState,
        id,
        doc,
        yText
      );
    });
    removed.forEach(id => {
      this.quillCursors.removeCursor(id.toString());
    });
  };

  destroy() {
    this.yText.unobserve(this._yObserver);
    this.quill.off('editor-change', this._quillObserver as any);
    if (this.awareness) {
      this.awareness.off('change', this._awarenessChange);
    }
  }
}