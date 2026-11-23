import { describe, expect, it } from 'vitest';
import {
    pickDetailThumbnailSize,
    pickExactThumbnailSize,
    pickGridThumbnailSize,
} from '../app/utils/thumbnail-size';
import {
    isEditableTarget,
    resolveViewerShortcut,
    stepZoom,
    type ViewerShortcutState,
} from '../app/utils/viewer';

const baseState: ViewerShortcutState = {
    shortcutsOpen: false,
    deleteOpen: false,
    renameOpen: false,
    infoOpen: false,
    canPlayUgoira: false,
    hasLive: false,
    favoriteSaving: false,
};

function editable(): EventTarget {
    return { tagName: 'INPUT' } as unknown as EventTarget;
}

describe('thumbnail size selection', () => {
    it('picks detail sizes by physical pixels', () => {
        expect(pickDetailThumbnailSize(100, 1)).toBe(256);
        expect(pickDetailThumbnailSize(600, 2)).toBe(1024);
        expect(pickDetailThumbnailSize(2000, 2)).toBe(4096);
        expect(pickDetailThumbnailSize(100, 1, [128, 256])).toBe(128);
    });

    it('picks exact cover sizes for dwell upgrades', () => {
        expect(pickExactThumbnailSize(100, 1)).toBe(256);
        // 300×2=600：快速档可能退到 512，升级档必须覆盖 600
        expect(pickExactThumbnailSize(300, 2)).toBe(1024);
        expect(pickExactThumbnailSize(600, 1)).toBe(1024);
        expect(pickExactThumbnailSize(3000, 2)).toBe(4096);
    });

    it('picks grid sizes by physical pixels', () => {
        expect(pickGridThumbnailSize(100, 1)).toBe(128);
        expect(pickGridThumbnailSize(100, 2)).toBe(256);
        expect(pickGridThumbnailSize(300, 2)).toBe(512);
    });
});

describe('viewer zoom', () => {
    it('steps and clamps between 0.2 and 8', () => {
        expect(stepZoom(1, 1)).toBe(1.2);
        expect(stepZoom(7.9, 1)).toBe(8);
        expect(stepZoom(0.3, -1)).toBe(0.2);
        expect(stepZoom(1.1, 1)).toBe(1.3);
    });
});

describe('viewer shortcuts', () => {
    it('detects editable targets', () => {
        expect(isEditableTarget(null)).toBe(false);
        expect(isEditableTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
        expect(isEditableTarget(editable())).toBe(true);
        expect(isEditableTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true);
    });

    it('maps navigation, zoom and action keys', () => {
        expect(resolveViewerShortcut({ key: 'ArrowLeft', target: null }, baseState)).toEqual({
            action: 'prev',
            preventDefault: true,
        });
        expect(resolveViewerShortcut({ key: 'd', target: null }, baseState)?.action).toBe('next');
        expect(resolveViewerShortcut({ key: 'W', target: null }, baseState)?.action).toBe('zoom-in');
        expect(resolveViewerShortcut({ key: 'ArrowDown', target: null }, baseState)?.action).toBe('zoom-out');
        expect(resolveViewerShortcut({ key: '0', target: null }, baseState)?.action).toBe('reset');
        expect(resolveViewerShortcut({ key: 'I', target: null }, baseState)?.action).toBe('toggle-info');
        expect(resolveViewerShortcut({ key: 'F', target: null }, baseState)?.action).toBe('toggle-favorite');
        expect(resolveViewerShortcut({ key: '?', target: null }, baseState)?.action).toBe('open-shortcuts');
    });

    it('unwinds dialogs before closing the viewer', () => {
        expect(resolveViewerShortcut({ key: 'Escape', target: null }, { ...baseState, shortcutsOpen: true })?.action)
            .toBe('close-shortcuts');
        expect(resolveViewerShortcut({ key: 'Escape', target: null }, { ...baseState, deleteOpen: true })?.action)
            .toBe('close-delete');
        expect(resolveViewerShortcut({ key: 'Escape', target: null }, { ...baseState, renameOpen: true })?.action)
            .toBe('close-rename');
        expect(resolveViewerShortcut({ key: 'Escape', target: null }, { ...baseState, infoOpen: true })?.action)
            .toBe('close-info');
        expect(resolveViewerShortcut({ key: 'Escape', target: null }, baseState)).toEqual({
            action: 'close-viewer',
            preventDefault: false,
        });
    });

    it('ignores inputs, modifiers and blocking dialogs', () => {
        expect(resolveViewerShortcut({ key: 'ArrowLeft', target: editable() }, baseState)).toBeNull();
        expect(resolveViewerShortcut({ key: 'd', ctrlKey: true, target: null }, baseState)).toBeNull();
        expect(resolveViewerShortcut({ key: 'a', target: null }, { ...baseState, shortcutsOpen: true })).toBeNull();
        expect(resolveViewerShortcut({ key: 'ArrowLeft', target: null }, { ...baseState, deleteOpen: true })).toBeNull();
        expect(resolveViewerShortcut({ key: 'f', target: null }, { ...baseState, favoriteSaving: true })).toBeNull();
    });

    it('plays ugoira or toggles live photos with Space', () => {
        expect(resolveViewerShortcut({ key: ' ', code: 'Space', target: null }, baseState)).toBeNull();
        expect(resolveViewerShortcut(
            { key: ' ', code: 'Space', target: null },
            { ...baseState, canPlayUgoira: true },
        )?.action).toBe('play-ugoira');
        expect(resolveViewerShortcut(
            { key: ' ', code: 'Space', target: null },
            { ...baseState, hasLive: true },
        )?.action).toBe('toggle-live');
    });
});
