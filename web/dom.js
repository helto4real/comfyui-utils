export function createSelectorDom({
    document,
    icons,
    cols,
    rootFolderLabel,
    subfolderLabel,
    sortBy,
    containPointerEvents,
}) {
    const widgetFrame = document.createElement("div");
    widgetFrame.className = "helto-selector-widget";
    containPointerEvents(widgetFrame);

    const container = document.createElement("div");
    container.className = "helto-selector-container";
    containPointerEvents(container);
    widgetFrame.appendChild(container);

    container.innerHTML = `
            <!-- Toolbar Row -->
            <div class="helto-toolbar">
                <button class="helto-btn-icon helto-recursive-btn" title="Toggle Recursive Scan">${icons.recursive}</button>
                <button class="helto-btn-icon helto-aspect-btn" title="Toggle Thumbnail Aspect Ratio (Fit/Fill)">${icons.aspect}</button>
                <button class="helto-btn-icon helto-folder-btn" title="Manage Folders">${icons.folder}</button>
                <button class="helto-btn-icon helto-refresh-btn" title="Refresh Images">${icons.refresh}</button>
                <button class="helto-btn-icon helto-gear-btn" title="Properties Settings">${icons.gear}</button>
                <div class="helto-search-container">
                    <span class="helto-search-icon">${icons.search}</span>
                    <input type="text" class="helto-search-input" placeholder="Search images...">
                </div>
            </div>
            
            <!-- Controls Row -->
            <div class="helto-controls">
                <div class="helto-slider-group">
                    <span class="helto-label">Thumbnails per Row</span>
                    <input type="range" class="helto-col-slider" min="2" max="8" value="${cols}">
                    <span class="helto-slider-val">${cols}</span>
                </div>
                <div class="helto-filter-sort-group">
                    <div class="helto-folder-filter-group">
                        <span class="helto-label">Folder:</span>
                        <span class="helto-folder-filter-link">${rootFolderLabel}</span>
                    </div>
                    <div class="helto-subfolder-filter-group">
                        <span class="helto-label">Subfolder:</span>
                        <span class="helto-subfolder-filter-link">${subfolderLabel}</span>
                    </div>
                    <div class="helto-sort-group">
                        <span class="helto-label">Sort:</span>
                        <span class="helto-sort-link">${sortBy}</span>
                    </div>
                </div>
            </div>
            
            <!-- Grid Scroll Area -->
            <div class="helto-grid"></div>
            
            <!-- Footer Row -->
            <div class="helto-footer">
                <div class="helto-status-group">
                    <span class="helto-status-text">0 Images Selected • 0 MB</span>
                    <button class="helto-btn-icon helto-selected-preview-btn" title="Show Selected Images" disabled>${icons.preview}</button>
                </div>
                <div class="helto-footer-actions">
                    <button class="helto-btn-icon helto-delete-selected-btn" title="Delete Selected Images" disabled>${icons.trash}</button>
                    <button class="helto-btn-icon helto-clear-btn" title="Clear Selection">${icons.clear}</button>
                </div>
            </div>
        `;

    return { widgetFrame, container };
}

export function getSelectorElements(container) {
    return {
        gridEl: container.querySelector(".helto-grid"),
        recursiveBtn: container.querySelector(".helto-recursive-btn"),
        aspectBtn: container.querySelector(".helto-aspect-btn"),
        folderBtn: container.querySelector(".helto-folder-btn"),
        refreshBtn: container.querySelector(".helto-refresh-btn"),
        gearBtn: container.querySelector(".helto-gear-btn"),
        searchInput: container.querySelector(".helto-search-input"),
        colSlider: container.querySelector(".helto-col-slider"),
        sliderVal: container.querySelector(".helto-slider-val"),
        sortLink: container.querySelector(".helto-sort-link"),
        folderFilterLink: container.querySelector(".helto-folder-filter-link"),
        subfolderFilterLink: container.querySelector(".helto-subfolder-filter-link"),
        footerText: container.querySelector(".helto-status-text"),
        selectedPreviewBtn: container.querySelector(".helto-selected-preview-btn"),
        deleteSelectedBtn: container.querySelector(".helto-delete-selected-btn"),
        clearBtn: container.querySelector(".helto-clear-btn"),
    };
}
