import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TASKS_VERSION = 5;
const VALID_STATUSES = new Set(['backlog', 'in-progress', 'blocked', 'done']);
const EDGE_OPTIONS = [
    {id: 'left', label: 'Left'},
    {id: 'right', label: 'Right'},
    {id: 'top', label: 'Top'},
    {id: 'bottom', label: 'Bottom'},
];
const MONITOR_OPTIONS = [
    {id: 'primary', label: 'Primary display'},
    {id: 'outer-edge', label: 'Outer display edge'},
];
const STORAGE_OPTIONS = [
    {id: 'default', label: 'Default'},
    {id: 'custom', label: 'Custom file'},
];
const APPEARANCE_OPTIONS = [
    {id: 'off-white', label: 'Off-white'},
    {id: 'transparent', label: 'Transparent'},
    {id: 'theme', label: 'Follow GNOME theme'},
    {id: 'custom', label: 'Custom color'},
];
const HANDLE_OPTIONS = [
    {id: 'auto', label: 'Visible when hidden'},
    {id: 'always', label: 'Always visible'},
    {id: 'transparent', label: 'Transparent hit area'},
];

function getDefaultStoragePath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        'edge-kanban',
        'tasks.json',
    ]);
}

function expandPath(path) {
    if (path === '~')
        return GLib.get_home_dir();

    if (path.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);

    return path;
}

function getActiveStoragePath(settings) {
    const storageMode = settings.get_string('storage-mode');
    const customPath = expandPath(settings.get_string('storage-path').trim());

    if (storageMode === 'custom' && customPath)
        return customPath;

    return getDefaultStoragePath();
}

function normalizeHexColor(value) {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());

    if (!match)
        return null;

    return `#${match[1].toLowerCase()}`;
}

function createId() {
    return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function normalizeDate(value) {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
        return value;

    return new Date().toISOString();
}

function normalizeNullableDate(value) {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
        return value;

    return null;
}

function normalizeTasks(data) {
    const rawTasks = Array.isArray(data) ? data : data?.tasks;

    if (!Array.isArray(rawTasks)) {
        if (data?.routine)
            return [];

        throw new Error('Expected a JSON object with a tasks array.');
    }

    const statusCounts = new Map();

    const normalizedTasks = rawTasks
        .filter(task => {
            return typeof task?.title === 'string' &&
                VALID_STATUSES.has(task?.status);
        })
        .map(task => {
            const fallbackOrder = statusCounts.get(task.status) ?? 0;
            const order = normalizeOrder(task.order, fallbackOrder);

            statusCounts.set(task.status, fallbackOrder + 1);

            return {
                id: String(task.id ?? createId()),
                title: task.title.trim(),
                status: task.status,
                order,
                notes: normalizeNotes(task.notes),
                createdAt: normalizeDate(task.createdAt),
                updatedAt: normalizeDate(task.updatedAt ?? task.createdAt),
                deletedAt: normalizeNullableDate(task.deletedAt),
            };
        })
        .filter(task => task.title.length > 0);

    return normalizeTaskOrder(normalizedTasks);
}

function createEmptyRoutine() {
    return {
        resetDate: todayKey(),
        items: [],
    };
}

function normalizeRoutine(data) {
    const rawRoutine = data?.routine;
    const rawItems = Array.isArray(rawRoutine) ? rawRoutine : rawRoutine?.items;

    if (!Array.isArray(rawItems))
        return createEmptyRoutine();

    const normalizedItems = rawItems
        .filter(item => typeof item?.title === 'string')
        .map((item, index) => {
            return {
                id: String(item.id ?? createId()),
                title: item.title.trim(),
                checked: item.checked === true,
                order: normalizeOrder(item.order, index),
                createdAt: normalizeDate(item.createdAt),
                updatedAt: normalizeDate(item.updatedAt ?? item.createdAt),
                deletedAt: normalizeNullableDate(item.deletedAt),
            };
        })
        .filter(item => item.title.length > 0);

    return {
        resetDate: normalizeDayKey(rawRoutine?.resetDate) ?? todayKey(),
        items: normalizeRoutineOrder(normalizedItems),
    };
}

function normalizeData(data) {
    return {
        tasks: normalizeTasks(data),
        routine: normalizeRoutine(data),
    };
}

function normalizeNotes(value) {
    return typeof value === 'string' ? value : '';
}

function normalizeOrder(value, fallback) {
    const order = Number(value);

    if (Number.isFinite(order))
        return order;

    return fallback;
}

function normalizeTaskOrder(tasks) {
    const byStatus = new Map();

    for (const task of tasks) {
        const statusTasks = byStatus.get(task.status) ?? [];
        statusTasks.push(task);
        byStatus.set(task.status, statusTasks);
    }

    for (const statusTasks of byStatus.values()) {
        const sortByOrder = (a, b) => {
            if (a.order !== b.order)
                return a.order - b.order;

            return a.createdAt.localeCompare(b.createdAt);
        };
        const visibleTasks = statusTasks
            .filter(task => !task.deletedAt)
            .sort(sortByOrder);
        const deletedTasks = statusTasks
            .filter(task => task.deletedAt)
            .sort(sortByOrder);

        visibleTasks.forEach((task, index) => {
            task.order = index;
        });
        deletedTasks.forEach((task, index) => {
            task.order = visibleTasks.length + index;
        });
    }

    return [...tasks].sort((a, b) => {
        if (a.status !== b.status)
            return a.status.localeCompare(b.status);

        return a.order - b.order;
    });
}

function normalizeRoutineOrder(items) {
    const sortByOrder = (a, b) => {
        if (a.order !== b.order)
            return a.order - b.order;

        return a.createdAt.localeCompare(b.createdAt);
    };
    const visibleItems = items
        .filter(item => !item.deletedAt)
        .sort(sortByOrder);
    const deletedItems = items
        .filter(item => item.deletedAt)
        .sort(sortByOrder);

    visibleItems.forEach((item, index) => {
        item.order = index;
    });
    deletedItems.forEach((item, index) => {
        item.order = visibleItems.length + index;
    });

    return [...visibleItems, ...deletedItems];
}

function normalizeDayKey(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
        return value;

    return null;
}

function todayKey() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d');
}

function ensureParentDirectory(file) {
    const parent = file.get_parent();

    try {
        parent.make_directory_with_parents(null);
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw error;
    }
}

function loadDataFromFile(file) {
    try {
        const [, contents] = file.load_contents(null);
        return normalizeData(JSON.parse(new TextDecoder().decode(contents)));
    } catch (error) {
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
            return {
                tasks: [],
                routine: createEmptyRoutine(),
            };
        }

        throw error;
    }
}

function loadTasksFromFile(file) {
    return loadDataFromFile(file).tasks;
}

function saveDataToFile(file, data) {
    ensureParentDirectory(file);
    file.replace_contents(
        JSON.stringify({
            version: TASKS_VERSION,
            tasks: data.tasks,
            routine: data.routine,
        }, null, 2),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null);
}

function saveTasksToFile(file, tasks) {
    saveDataToFile(file, {
        tasks,
        routine: createEmptyRoutine(),
    });
}

function taskTimestamp(task) {
    const updatedAt = Date.parse(task.updatedAt ?? task.createdAt ?? 0);
    const deletedAt = task.deletedAt ? Date.parse(task.deletedAt) : 0;

    return Math.max(
        Number.isNaN(updatedAt) ? 0 : updatedAt,
        Number.isNaN(deletedAt) ? 0 : deletedAt);
}

function mergeTasks(currentTasks, incomingTasks) {
    const merged = new Map();

    for (const task of currentTasks)
        merged.set(task.id, task);

    for (const task of incomingTasks) {
        const existing = merged.get(task.id);

        if (!existing || taskTimestamp(task) >= taskTimestamp(existing))
            merged.set(task.id, task);
    }

    return normalizeTaskOrder([...merged.values()]);
}

function routineItemTimestamp(item) {
    const updatedAt = Date.parse(item.updatedAt ?? item.createdAt ?? 0);
    const deletedAt = item.deletedAt ? Date.parse(item.deletedAt) : 0;

    return Math.max(
        Number.isNaN(updatedAt) ? 0 : updatedAt,
        Number.isNaN(deletedAt) ? 0 : deletedAt);
}

function mergeRoutine(currentRoutine, incomingRoutine) {
    const merged = new Map();
    const currentResetDate = normalizeDayKey(currentRoutine?.resetDate) ?? todayKey();
    const incomingResetDate = normalizeDayKey(incomingRoutine?.resetDate) ?? todayKey();

    for (const item of currentRoutine?.items ?? [])
        merged.set(item.id, item);

    for (const item of incomingRoutine?.items ?? []) {
        const existing = merged.get(item.id);

        if (!existing || routineItemTimestamp(item) >= routineItemTimestamp(existing))
            merged.set(item.id, item);
    }

    return {
        resetDate: currentResetDate > incomingResetDate ? currentResetDate : incomingResetDate,
        items: normalizeRoutineOrder([...merged.values()]),
    };
}

function mergeData(currentData, incomingData) {
    return {
        tasks: mergeTasks(currentData.tasks, incomingData.tasks),
        routine: mergeRoutine(currentData.routine, incomingData.routine),
    };
}

class EdgeKanbanPreferencesPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(settings) {
        super({
            title: 'Edge Kanban',
            icon_name: 'view-list-symbolic',
        });

        this._settings = settings;
        this._settingsSignalIds = [];
        this.connect('destroy', this._onDestroy.bind(this));

        this._addPanelGroup();
        this._addAppearanceGroup();
        this._addStorageGroup();

        this._connectSettingsSignal('changed::handle-mode',
            () => this._syncHandleRows());
        this._connectSettingsSignal('changed::monitor-mode',
            () => this._syncMonitorRows());
        this._connectSettingsSignal('changed::background-mode',
            () => this._syncAppearanceRows());
        this._connectSettingsSignal('changed::background-color',
            () => this._syncAppearanceRows());
        this._connectSettingsSignal('changed::storage-mode',
            () => this._syncStorageRows());
        this._connectSettingsSignal('changed::storage-path',
            () => this._syncStorageRows());
        this._syncHandleRows();
        this._syncMonitorRows();
        this._syncAppearanceRows();
        this._syncStorageRows();
    }

    _connectSettingsSignal(signalName, callback) {
        this._settingsSignalIds.push(this._settings.connect(signalName, callback));
    }

    _onDestroy() {
        for (const signalId of this._settingsSignalIds)
            this._settings.disconnect(signalId);

        this._settingsSignalIds = [];
    }

    _addPanelGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Panel',
            description: 'Choose where the board hides and how much space it uses.',
        });
        this.add(group);

        this._addEdgeRow(group);
        this._monitorModeRow = this._createMonitorModeRow();
        group.add(this._monitorModeRow);
        this._addSpinRow(group, {
            key: 'side-size',
            title: 'Side width',
            subtitle: 'Width in pixels when anchored to the left or right edge.',
            lower: 280,
            upper: 720,
            step: 10,
        });
        this._addSpinRow(group, {
            key: 'bar-size',
            title: 'Top/bottom height',
            subtitle: 'Height in pixels when anchored to the top or bottom edge.',
            lower: 220,
            upper: 560,
            step: 10,
        });
        this._addSpinRow(group, {
            key: 'handle-size',
            title: 'Handle size',
            subtitle: 'Visible pixels left on screen while hidden.',
            lower: 6,
            upper: 40,
            step: 1,
        });
        this._addSpinRow(group, {
            key: 'handle-coverage',
            title: 'Handle coverage',
            subtitle: 'Percentage of the edge used as the centered reveal target.',
            lower: 10,
            upper: 100,
            step: 5,
        });
        this._handleModeRow = this._createHandleModeRow();
        group.add(this._handleModeRow);
        this._addSpinRow(group, {
            key: 'hide-delay-ms',
            title: 'Hide delay',
            subtitle: 'Delay in milliseconds after the pointer leaves the board.',
            lower: 0,
            upper: 3000,
            step: 50,
        });
    }

    _createHandleModeRow() {
        const model = new Gtk.StringList();

        for (const option of HANDLE_OPTIONS)
            model.append(option.label);

        const row = new Adw.ComboRow({
            title: 'Handle visibility',
            subtitle: 'Keep the edge target active while controlling whether the colored bar is shown.',
            model,
        });
        const currentMode = this._settings.get_string('handle-mode');
        const selected = HANDLE_OPTIONS.findIndex(option => option.id === currentMode);
        row.set_selected(selected >= 0 ? selected : 0);
        row.connect('notify::selected', widget => {
            const option = HANDLE_OPTIONS[widget.get_selected()];

            if (option && option.id !== this._settings.get_string('handle-mode'))
                this._settings.set_string('handle-mode', option.id);
        });

        return row;
    }

    _createMonitorModeRow() {
        const model = new Gtk.StringList();

        for (const option of MONITOR_OPTIONS)
            model.append(option.label);

        const row = new Adw.ComboRow({
            title: 'Monitor',
            subtitle: 'Use the primary display, or the far outside edge of the joined desktop.',
            model,
        });
        const currentMode = this._settings.get_string('monitor-mode');
        const selected = MONITOR_OPTIONS.findIndex(option => option.id === currentMode);
        row.set_selected(selected >= 0 ? selected : 0);
        row.connect('notify::selected', widget => {
            const option = MONITOR_OPTIONS[widget.get_selected()];

            if (option && option.id !== this._settings.get_string('monitor-mode'))
                this._settings.set_string('monitor-mode', option.id);
        });

        return row;
    }

    _syncHandleRows() {
        if (!this._handleModeRow)
            return;

        const handleMode = this._settings.get_string('handle-mode');
        const selected = HANDLE_OPTIONS.findIndex(option => option.id === handleMode);

        this._handleModeRow.set_selected(selected >= 0 ? selected : 0);
    }

    _syncMonitorRows() {
        if (!this._monitorModeRow)
            return;

        const monitorMode = this._settings.get_string('monitor-mode');
        const selected = MONITOR_OPTIONS.findIndex(option => option.id === monitorMode);

        this._monitorModeRow.set_selected(selected >= 0 ? selected : 0);
    }

    _addAppearanceGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Choose whether the board has a soft surface, stays transparent, follows GNOME, or uses a custom color.',
        });
        this.add(group);

        this._backgroundModeRow = this._createBackgroundModeRow();
        group.add(this._backgroundModeRow);

        this._customBackgroundRow = new Adw.ActionRow({
            title: 'Custom background color',
            subtitle: 'Hex color used when background is set to custom.',
        });
        this._customBackgroundEntry = new Gtk.Entry({
            valign: Gtk.Align.CENTER,
            width_chars: 9,
            max_width_chars: 9,
            text: this._settings.get_string('background-color'),
        });
        this._customBackgroundEntry.connect('changed', widget => {
            const color = normalizeHexColor(widget.get_text());

            if (color && color !== this._settings.get_string('background-color'))
                this._settings.set_string('background-color', color);
        });
        this._customBackgroundRow.add_suffix(this._customBackgroundEntry);
        this._customBackgroundRow.activatable_widget = this._customBackgroundEntry;
        group.add(this._customBackgroundRow);
    }

    _createBackgroundModeRow() {
        const model = new Gtk.StringList();

        for (const option of APPEARANCE_OPTIONS)
            model.append(option.label);

        const row = new Adw.ComboRow({
            title: 'Background',
            model,
        });
        const currentMode = this._settings.get_string('background-mode');
        const selected = APPEARANCE_OPTIONS.findIndex(option => option.id === currentMode);
        row.set_selected(selected >= 0 ? selected : 0);
        row.connect('notify::selected', widget => {
            const option = APPEARANCE_OPTIONS[widget.get_selected()];

            if (option && option.id !== this._settings.get_string('background-mode'))
                this._settings.set_string('background-mode', option.id);
        });

        return row;
    }

    _syncAppearanceRows() {
        if (!this._backgroundModeRow || !this._customBackgroundEntry)
            return;

        const backgroundMode = this._settings.get_string('background-mode');
        const selected = APPEARANCE_OPTIONS.findIndex(option => option.id === backgroundMode);
        const color = this._settings.get_string('background-color');

        this._backgroundModeRow.set_selected(selected >= 0 ? selected : 0);

        if (this._customBackgroundEntry.get_text() !== color)
            this._customBackgroundEntry.set_text(color);

        this._customBackgroundEntry.set_sensitive(backgroundMode === 'custom');
    }

    _addStorageGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Storage & Backup',
            description: 'Use the default XDG config file, or point storage at a synced JSON file.',
        });
        this.add(group);

        this._storageModeRow = this._createStorageModeRow();
        group.add(this._storageModeRow);

        this._activePathRow = new Adw.ActionRow({
            title: 'Active storage file',
        });
        group.add(this._activePathRow);

        group.add(this._createActionRow(
            'Choose custom storage file',
            'Merge current tasks into a chosen JSON file, then use it for storage.',
            'Choose...',
            () => this._chooseCustomStorageFile()));

        group.add(this._createActionRow(
            'Reset to default storage',
            'Use the XDG config file again.',
            'Reset',
            () => this._resetToDefaultStorage()));

        group.add(this._createActionRow(
            'Export tasks',
            'Save a backup copy of the active task file.',
            'Export...',
            () => this._exportTasks()));

        group.add(this._createActionRow(
            'Import tasks',
            'Replace current tasks with a JSON backup.',
            'Replace...',
            () => this._importTasks({merge: false})));

        group.add(this._createActionRow(
            'Merge tasks',
            'Merge a JSON backup using per-task timestamps.',
            'Merge...',
            () => this._importTasks({merge: true})));

        group.add(this._createActionRow(
            'Open data folder',
            'Open the folder containing the active task file.',
            'Open',
            () => this._openDataFolder()));

        this._statusRow = new Adw.ActionRow({
            title: 'Status',
            subtitle: '',
        });
        group.add(this._statusRow);
    }

    _createStorageModeRow() {
        const model = new Gtk.StringList();

        for (const option of STORAGE_OPTIONS)
            model.append(option.label);

        const row = new Adw.ComboRow({
            title: 'Storage location',
            model,
        });
        const currentMode = this._settings.get_string('storage-mode');
        const selected = STORAGE_OPTIONS.findIndex(option => option.id === currentMode);
        row.set_selected(selected >= 0 ? selected : 0);
        row.connect('notify::selected', widget => {
            const option = STORAGE_OPTIONS[widget.get_selected()];

            if (option)
                this._settings.set_string('storage-mode', option.id);
        });

        return row;
    }

    _createActionRow(title, subtitle, buttonLabel, callback) {
        const row = new Adw.ActionRow({
            title,
            subtitle,
        });
        const button = new Gtk.Button({
            label: buttonLabel,
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', callback);
        row.add_suffix(button);
        row.activatable_widget = button;

        return row;
    }

    _syncStorageRows() {
        if (!this._activePathRow || !this._storageModeRow)
            return;

        const activePath = getActiveStoragePath(this._settings);
        const storageMode = this._settings.get_string('storage-mode');
        const selected = STORAGE_OPTIONS.findIndex(option => option.id === storageMode);

        this._activePathRow.set_subtitle(activePath);
        this._storageModeRow.set_selected(selected >= 0 ? selected : 0);
    }

    _setStatus(message) {
        this._statusRow.set_subtitle(message);
    }

    _getRootWindow() {
        return this.get_root();
    }

    _createJsonFilter() {
        const filter = new Gtk.FileFilter();
        filter.set_name('JSON files');
        filter.add_mime_type('application/json');
        filter.add_pattern('*.json');

        return filter;
    }

    _createFilterList() {
        const filters = new Gio.ListStore({
            item_type: Gtk.FileFilter,
        });
        filters.append(this._createJsonFilter());

        return filters;
    }

    _chooseCustomStorageFile() {
        const dialog = new Gtk.FileDialog({
            title: 'Choose Edge Kanban Storage File',
            initial_name: 'tasks.json',
            filters: this._createFilterList(),
        });

        dialog.save(this._getRootWindow(), null, (source, result) => {
            try {
                const file = source.save_finish(result);
                const path = file.get_path();

                if (!path)
                    throw new Error('Custom storage must be a local file.');

                const activeFile = Gio.File.new_for_path(getActiveStoragePath(this._settings));
                const mergedData = mergeData(
                    loadDataFromFile(file),
                    loadDataFromFile(activeFile));

                saveDataToFile(file, mergedData);
                this._settings.set_string('storage-path', path);
                this._settings.set_string('storage-mode', 'custom');
                this._setStatus(`Using custom storage: ${path}`);
            } catch (error) {
                if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    this._setStatus(`Could not choose storage file: ${error.message}`);
            }
        });
    }

    _resetToDefaultStorage() {
        try {
            const activeFile = Gio.File.new_for_path(getActiveStoragePath(this._settings));
            const defaultFile = Gio.File.new_for_path(getDefaultStoragePath());
            const mergedData = mergeData(
                loadDataFromFile(defaultFile),
                loadDataFromFile(activeFile));

            saveDataToFile(defaultFile, mergedData);
            this._settings.set_string('storage-mode', 'default');
            this._setStatus(`Using default storage: ${defaultFile.get_path()}`);
        } catch (error) {
            this._setStatus(`Could not reset storage: ${error.message}`);
        }
    }

    _exportTasks() {
        const dialog = new Gtk.FileDialog({
            title: 'Export Edge Kanban Tasks',
            initial_name: 'edge-kanban-tasks.json',
            filters: this._createFilterList(),
        });

        dialog.save(this._getRootWindow(), null, (source, result) => {
            try {
                const destination = source.save_finish(result);
                const activeFile = Gio.File.new_for_path(getActiveStoragePath(this._settings));
                const data = loadDataFromFile(activeFile);

                saveDataToFile(destination, data);
                this._setStatus(`Exported ${data.tasks.length} tasks and ${data.routine.items.filter(item => !item.deletedAt).length} routine items.`);
            } catch (error) {
                if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    this._setStatus(`Export failed: ${error.message}`);
            }
        });
    }

    _importTasks({merge}) {
        const dialog = new Gtk.FileDialog({
            title: merge ? 'Merge Edge Kanban Tasks' : 'Import Edge Kanban Tasks',
            filters: this._createFilterList(),
        });

        dialog.open(this._getRootWindow(), null, (source, result) => {
            try {
                const sourceFile = source.open_finish(result);
                const incomingData = loadDataFromFile(sourceFile);
                const activeFile = Gio.File.new_for_path(getActiveStoragePath(this._settings));
                const nextData = merge
                    ? mergeData(loadDataFromFile(activeFile), incomingData)
                    : incomingData;

                saveDataToFile(activeFile, nextData);
                this._setStatus(`${merge ? 'Merged' : 'Imported'} ${incomingData.tasks.length} tasks and ${incomingData.routine.items.filter(item => !item.deletedAt).length} routine items.`);
            } catch (error) {
                if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    this._setStatus(`Import failed: ${error.message}`);
            }
        });
    }

    _openDataFolder() {
        try {
            const file = Gio.File.new_for_path(getActiveStoragePath(this._settings));
            ensureParentDirectory(file);
            Gio.AppInfo.launch_default_for_uri(file.get_parent().get_uri(), null);
            this._setStatus('Opened data folder.');
        } catch (error) {
            this._setStatus(`Could not open data folder: ${error.message}`);
        }
    }

    _addEdgeRow(group) {
        const model = new Gtk.StringList();

        for (const option of EDGE_OPTIONS)
            model.append(option.label);

        const row = new Adw.ComboRow({
            title: 'Screen edge',
            subtitle: 'Side edges use a vertical task list; top and bottom use Kanban columns.',
            model,
        });
        const currentEdge = this._settings.get_string('edge');
        const selected = EDGE_OPTIONS.findIndex(option => option.id === currentEdge);
        row.set_selected(selected >= 0 ? selected : 0);
        row.connect('notify::selected', widget => {
            const option = EDGE_OPTIONS[widget.get_selected()];

            if (option)
                this._settings.set_string('edge', option.id);
        });

        group.add(row);
    }

    _addSpinRow(group, {key, title, subtitle, lower, upper, step}) {
        const adjustment = new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 10,
            value: this._settings.get_int(key),
        });
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment,
            digits: 0,
            numeric: true,
        });

        this._settings.bind(
            key,
            row,
            'value',
            Gio.SettingsBindFlags.DEFAULT);

        group.add(row);
    }
}

export default class EdgeKanbanPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.add(new EdgeKanbanPreferencesPage(this.getSettings()));
    }

    getPreferencesWidget() {
        return new EdgeKanbanPreferencesPage(this.getSettings());
    }
}
