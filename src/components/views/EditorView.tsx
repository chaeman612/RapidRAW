import { type RefObject, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';

import Editor from '../panel/Editor';
import BottomBar from '../panel/BottomBar';
import Resizer from '../ui/Resizer';
import { MobilePanelSwitcher } from '../panel/PanelSwitcher';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { useSliderPeekStore } from '../../store/useSliderPeekStore';

// Phone crop mode: a short options panel so the photo being cropped stays large.
const PHONE_CROP_PANEL_HEIGHT = 212;
// Category strip + toolbar at the bottom of the phone panel, kept clear of the photo.
const PHONE_PANEL_CHROME_HEIGHT = 120;
const PHONE_PANEL_GAP = 8;
// Editor toolbar above the photo, and the photo's horizontal inset.
const PHONE_EDITOR_TOP_CHROME = 56;
const PHONE_EDITOR_SIDE_PADDING = 16;

import { useEditorStore } from '../../store/useEditorStore';
import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useProcessStore } from '../../store/useProcessStore';
import { getImageFlag } from '../../utils/imageFlags';

import { ImageFile, Orientation, Panel, ThumbnailAspectRatio } from '../ui/AppProperties';

interface EditorViewProps {
  transformWrapperRef: RefObject<any>;
  isResizing: boolean;
  layoutMode: 'compact' | 'wide' | 'full';
  isAndroid: boolean;
  compactEditorPanelHeight: number;
  compactEditorPanelCollapsedHeight: number;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  sortedImageList: ImageFile[];
  createResizeHandler: (stateKey: string, startSize: number) => (e: ReactPointerEvent<HTMLDivElement>) => void;
  createResizeResetHandler: (stateKey: string) => () => void;
  handleBackToLibrary: () => void;
  handleEditorContextMenu: (...args: any) => void;
  handleThumbnailContextMenu: (...args: any) => void;
  handleMainLibraryContextMenu?: (...args: any) => void;
  handleImageClick: (...args: any) => void;
  handleClearSelection: () => void;
  handleCopyAdjustments: () => void;
  handlePasteAdjustments: () => void;
  handleRate: (...args: any) => void;
  handleZoomChange: (zoom: number) => void;
  handlePanelSelect: (panelId: any) => void;
  requestThumbnails: any;
  renderAppPanel: (panelId: any) => React.ReactNode;
}

export default function EditorView({
  transformWrapperRef,
  isResizing,
  layoutMode,
  isAndroid,
  compactEditorPanelHeight,
  compactEditorPanelCollapsedHeight,
  thumbnailAspectRatio,
  sortedImageList,
  createResizeHandler,
  createResizeResetHandler,
  handleBackToLibrary,
  handleEditorContextMenu,
  handleThumbnailContextMenu,
  handleMainLibraryContextMenu,
  handleImageClick,
  handleClearSelection,
  handleCopyAdjustments,
  handlePasteAdjustments,
  handleRate,
  handleZoomChange,
  handlePanelSelect,
  requestThumbnails,
  renderAppPanel,
}: EditorViewProps) {
  const isPhone = usePhoneLayout();
  const { selectedImage, originalSize, orientationSteps, cropAspectRatio } = useEditorStore(
    useShallow((state) => ({
      selectedImage: state.selectedImage,
      originalSize: state.originalSize,
      orientationSteps: state.adjustments?.orientationSteps || 0,
      cropAspectRatio: state.adjustments?.aspectRatio || 0,
    })),
  );

  // Size of the editor area, used on phones to decide how far the photo may
  // extend behind the translucent panel.
  const rootRef = useRef<HTMLDivElement>(null);
  const [rootSize, setRootSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setRootSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isPhone, layoutMode]);

  const { isFullScreen, isInstantTransition, uiVisibility, bottomPanelHeight, activePanel, setUI } = useUIStore(
    useShallow((state) => ({
      isFullScreen: state.isFullScreen,
      isInstantTransition: state.isInstantTransition,
      uiVisibility: state.uiVisibility,
      bottomPanelHeight: state.bottomPanelHeight,
      activePanel: state.activePanel,
      setUI: state.setUI,
    })),
  );
  const isPhoneCrop = isPhone && activePanel === Panel.Crop;
  // Phones: while a slider is dragged the panel fades out and only its value shows.
  const sliderPeek = useSliderPeekStore((state) => state.peek);
  const isPeeking = isPhone && !!sliderPeek;

  const { multiSelectedPaths, imageRatings, flag, isViewLoading } = useLibraryStore(
    useShallow((state) => ({
      multiSelectedPaths: state.multiSelectedPaths,
      imageRatings: state.imageRatings,
      flag: getImageFlag(state.imageList, selectedImage?.path),
      isViewLoading: state.isViewLoading,
    })),
  );

  const { isCopied, isPasted } = useProcessStore(
    useShallow((state) => ({
      isCopied: state.isCopied,
      isPasted: state.isPasted,
    })),
  );

  const editorNode = (
    <Editor
      onBackToLibrary={handleBackToLibrary}
      onContextMenu={handleEditorContextMenu}
      onImageSelect={handleImageClick}
      transformWrapperRef={transformWrapperRef}
    />
  );

  const editorBottomBarComponent = (
    <BottomBar
      filmstripHeight={bottomPanelHeight}
      imageList={sortedImageList}
      imageRatings={imageRatings}
      isCopied={isCopied}
      isCopyDisabled={!selectedImage}
      isFilmstripVisible={uiVisibility.filmstrip}
      isLoading={isViewLoading}
      isPasted={isPasted}
      isPasteDisabled={useEditorStore.getState().copiedAdjustments === null}
      isRatingDisabled={!selectedImage}
      isResizing={isResizing}
      multiSelectedPaths={multiSelectedPaths}
      onClearSelection={handleClearSelection}
      onContextMenu={handleThumbnailContextMenu}
      onEmptyAreaContextMenu={handleMainLibraryContextMenu}
      onCopy={handleCopyAdjustments}
      onOpenCopyPasteSettings={() => setUI({ isCopyPasteSettingsModalOpen: true })}
      onImageSelect={handleImageClick}
      onPaste={() => handlePasteAdjustments()}
      onRate={handleRate}
      onRequestThumbnails={requestThumbnails}
      onZoomChange={handleZoomChange}
      rating={imageRatings[selectedImage?.path || ''] || 0}
      flag={flag}
      selectedImage={selectedImage ?? undefined}
      showFilmstrip={layoutMode !== 'compact'}
      layoutMode={layoutMode}
      showZoomControls={!isAndroid}
      thumbnailAspectRatio={thumbnailAspectRatio}
      totalImages={sortedImageList.length}
    />
  );

  const editorBottomBarNode = (
    <div
      className={clsx(
        'flex flex-col w-full overflow-hidden shrink-0',
        !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
      )}
      style={{
        maxHeight: isFullScreen ? '0px' : '500px',
        opacity: isFullScreen ? 0 : 1,
      }}
    >
      {layoutMode !== 'compact' && (
        <Resizer
          direction={Orientation.Horizontal}
          onMouseDown={createResizeHandler('bottom', bottomPanelHeight)}
          onDoubleClick={createResizeResetHandler('bottom')}
        />
      )}
      {editorBottomBarComponent}
    </div>
  );

  const mobilePanelHeight = isFullScreen
    ? 0
    : isPhoneCrop
      ? PHONE_CROP_PANEL_HEIGHT
      : activePanel
        ? compactEditorPanelHeight
        : compactEditorPanelCollapsedHeight;
  // Phones: when the photo is taller than the space above the panel, it continues
  // behind the translucent panel content (never past the category strip and
  // toolbar), so it can be shown larger. Wide photos that already fit stay clear.
  const phonePanelOverlap = (() => {
    if (!isPhone || !activePanel || isPhoneCrop || isFullScreen || !rootSize.height) return 0;
    if (!originalSize.width || !originalSize.height) return 0;
    let ratio = originalSize.width / originalSize.height;
    if (orientationSteps % 2 !== 0) ratio = 1 / ratio;
    if (cropAspectRatio > 0) ratio = cropAspectRatio;
    const photoHeightAtFullWidth = (rootSize.width - PHONE_EDITOR_SIDE_PADDING) / ratio;
    const spaceAbovePanel = rootSize.height - mobilePanelHeight - PHONE_PANEL_GAP - PHONE_EDITOR_TOP_CHROME;
    const needed = photoHeightAtFullWidth - spaceAbovePanel;
    return Math.round(Math.min(Math.max(0, needed), Math.max(0, mobilePanelHeight - PHONE_PANEL_CHROME_HEIGHT)));
  })();

  const editorMobilePanelNode =
    layoutMode === 'compact' ? (
      <div
        className={clsx(
          'flex overflow-hidden shrink-0 flex-col rounded-lg',
          isPhone && phonePanelOverlap > 0 ? 'bg-bg-secondary/75 backdrop-blur-xl' : 'bg-bg-secondary',
          !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
        )}
        style={{
          height: mobilePanelHeight,
          opacity: isFullScreen || isPeeking ? 0 : 1,
          transition: isPeeking ? 'opacity 120ms ease-out' : undefined,
        }}
      >
        {activePanel && !isFullScreen && !isPhoneCrop && (
          <Resizer
            direction={Orientation.Horizontal}
            onMouseDown={createResizeHandler('compact', compactEditorPanelHeight)}
            onDoubleClick={createResizeResetHandler('compact')}
          />
        )}
        <div className="min-h-0 flex-1 overflow-hidden relative">
          <AnimatePresence mode="wait">
            {activePanel && (
              <motion.div
                key={activePanel}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.15 }}
                className="absolute inset-0 overflow-y-auto custom-scrollbar"
              >
                {renderAppPanel(activePanel)}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {/* Phone crop mode brings its own cancel/apply bar instead of the toolbar. */}
        {!isPhoneCrop && <MobilePanelSwitcher activePanel={activePanel} onPanelSelect={handlePanelSelect} />}
        {/* Phones: copy/paste live in the Adjust panel's category strip and rating in
            the library, keeping the editor's bottom area to a single toolbar. */}
        {!isPhone && <div className="shrink-0 border-t border-surface">{editorBottomBarComponent}</div>}
      </div>
    ) : null;

  if (layoutMode === 'compact' && isPhone) {
    return (
      <div className="relative grow h-full min-h-0" ref={rootRef}>
        <div
          className={clsx(
            'absolute inset-x-0 top-0 flex flex-col min-w-0',
            !isResizing && !isInstantTransition && 'transition-[bottom] duration-300 ease-in-out',
          )}
          style={{ bottom: mobilePanelHeight - phonePanelOverlap + (mobilePanelHeight > 0 ? PHONE_PANEL_GAP : 0) }}
        >
          {editorNode}
        </div>
        <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col">{editorMobilePanelNode}</div>
        <AnimatePresence>
          {isPeeking && sliderPeek && (
            <motion.div
              key="slider-peek"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="pointer-events-none absolute left-1/2 top-16 z-20 -translate-x-1/2 flex items-baseline gap-2 rounded-full bg-black/60 px-4 py-2 text-white shadow-lg backdrop-blur-md"
            >
              {sliderPeek.label && <span className="text-sm text-white/75">{sliderPeek.label}</span>}
              <span className="text-lg font-semibold tabular-nums">{sliderPeek.value}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className={clsx('flex grow h-full min-h-0', layoutMode === 'compact' ? 'flex-col gap-2' : 'flex-col')}>
      <div className={clsx('flex-1 flex flex-col min-w-0', layoutMode === 'compact' && 'min-h-0')}>{editorNode}</div>
      {layoutMode === 'compact' ? editorMobilePanelNode : editorBottomBarNode}
    </div>
  );
}
