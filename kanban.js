import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const COLUMN_DEFS = [
    {id: 'backlog', title: 'Backlog'},
    {id: 'in-progress', title: 'In Progress'},
    {id: 'blocked', title: 'Blocked'},
    {id: 'done', title: 'Done'},
];

const TASKS_VERSION = 5;
const DEFAULT_STORAGE_MODE = 'default';
const DEFAULT_BACKGROUND_MODE = 'off-white';
const DEFAULT_BACKGROUND_COLOR = '#f7f3ea';
const DEFAULT_HANDLE_MODE = 'auto';
const DEFAULT_HANDLE_COVERAGE = 70;
const DEFAULT_MONITOR_MODE = 'primary';
const VALID_STATUSES = new Set(COLUMN_DEFS.map(column => column.id));
const VALID_EDGES = new Set(['left', 'right', 'top', 'bottom']);
const VALID_BACKGROUND_MODES = new Set(['off-white', 'transparent', 'theme', 'custom']);
const VALID_HANDLE_MODES = new Set(['auto', 'always', 'transparent']);
const VALID_MONITOR_MODES = new Set(['primary', 'outer-edge']);
const ANIMATION_TIME = 220;
const PANEL_GTYPE_NAME = `EdgeKanbanPanel${GLib.get_monotonic_time()}`;
const ICON_SIZE = 16;
const ACCENT_COLORS = {
    blue: '53, 132, 228',
    teal: '33, 144, 164',
    green: '46, 194, 126',
    yellow: '245, 194, 17',
    orange: '255, 120, 0',
    red: '237, 51, 59',
    pink: '213, 97, 153',
    purple: '145, 65, 172',
    slate: '111, 131, 150',
};
const LIGHT_SURFACE = 'rgba(247, 243, 234, 0.94)';
const THEME_LIGHT_SURFACE = 'rgba(250, 249, 246, 0.94)';
const THEME_DARK_SURFACE = 'rgba(33, 33, 31, 0.88)';

class TaskStore {
    constructor(extension, settings, onChanged) {
        this._extension = extension;
        this._settings = settings;
        this._onChanged = onChanged;
        this._file = Gio.File.new_for_path(this._getStoragePath());
        this._tasks = [];
        this._routine = this._createEmptyRoutine();
        this._monitor = null;
        this._monitorId = 0;
        this._reloadTimeoutId = 0;
        this._routineResetTimeoutId = 0;
        this.load();
        this._scheduleRoutineReset();
        this._monitorFile();
    }

    get path() {
        return this._file.get_path();
    }

    _getDefaultStoragePath() {
        return GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'edge-kanban',
            'tasks.json',
        ]);
    }

    _getLegacyStoragePath() {
        const localExtensionsDir = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'gnome-shell',
            'extensions',
        ]);
        const extensionPath = this._extension.path ?? '';

        if (extensionPath.startsWith(localExtensionsDir))
            return GLib.build_filenamev([extensionPath, 'tasks.json']);

        return GLib.build_filenamev([
            localExtensionsDir,
            this._extension.metadata.uuid,
            'tasks.json',
        ]);
    }

    _expandPath(path) {
        if (path === '~')
            return GLib.get_home_dir();

        if (path.startsWith('~/'))
            return GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);

        return path;
    }

    _getStorageMode() {
        try {
            return this._settings.get_string('storage-mode');
        } catch (error) {
            return DEFAULT_STORAGE_MODE;
        }
    }

    _getStoragePath() {
        const storageMode = this._getStorageMode();
        let customPath = '';

        try {
            customPath = this._expandPath(this._settings.get_string('storage-path').trim());
        } catch (error) {
            customPath = '';
        }

        if (storageMode === 'custom' && customPath)
            return customPath;

        return this._getDefaultStoragePath();
    }

    reloadFromSettings() {
        const nextFile = Gio.File.new_for_path(this._getStoragePath());

        if (nextFile.get_path() === this.path)
            return false;

        this._file = nextFile;
        this.load();
        this._monitorFile();

        return true;
    }

    destroy() {
        if (this._reloadTimeoutId) {
            GLib.Source.remove(this._reloadTimeoutId);
            this._reloadTimeoutId = 0;
        }

        if (this._routineResetTimeoutId) {
            GLib.Source.remove(this._routineResetTimeoutId);
            this._routineResetTimeoutId = 0;
        }

        if (this._monitorId) {
            this._monitor.disconnect(this._monitorId);
            this._monitorId = 0;
        }

        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
    }

    _ensureDirectory() {
        const parent = this._file.get_parent();

        try {
            parent.make_directory_with_parents(null);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw error;
        }
    }

    _loadDataFromFile(file) {
        const [, contents] = file.load_contents(null);
        const data = JSON.parse(new TextDecoder().decode(contents));

        return this._normalizeData(data);
    }

    _loadTasksFromFile(file) {
        return this._loadDataFromFile(file).tasks;
    }

    _isNotFoundError(error) {
        return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
    }

    load() {
        try {
            const data = this._loadDataFromFile(this._file);

            this._tasks = data.tasks;
            this._routine = data.routine;

            if (this._resetRoutineIfNeeded())
                this.save();
        } catch (error) {
            if (!this._isNotFoundError(error)) {
                console.error(`Edge Kanban: failed to load tasks: ${error.message}`);
                this._tasks = [];
                this._routine = this._createEmptyRoutine();
                return;
            }

            const data = this._loadLegacyDataIfPossible();

            this._tasks = data.tasks;
            this._routine = data.routine;

            if (this._resetRoutineIfNeeded())
                this.save();

            this.save();
        }
    }

    _monitorFile() {
        if (this._monitorId) {
            this._monitor.disconnect(this._monitorId);
            this._monitorId = 0;
        }

        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }

        try {
            this._ensureDirectory();
            this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed',
                (_monitor, _file, _otherFile, eventType) => {
                    switch (eventType) {
                    case Gio.FileMonitorEvent.CHANGES_DONE_HINT:
                    case Gio.FileMonitorEvent.CREATED:
                    case Gio.FileMonitorEvent.DELETED:
                    case Gio.FileMonitorEvent.MOVED_IN:
                    case Gio.FileMonitorEvent.MOVED_OUT:
                        this._queueExternalReload();
                        break;
                    }
                });
        } catch (error) {
            console.error(`Edge Kanban: failed to monitor tasks file: ${error.message}`);
        }
    }

    _queueExternalReload() {
        if (this._reloadTimeoutId)
            GLib.Source.remove(this._reloadTimeoutId);

        this._reloadTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            150,
            () => {
                this._reloadTimeoutId = 0;
                this._mergeExternalChanges();
                this._onChanged?.();

                return GLib.SOURCE_REMOVE;
            });
    }

    _mergeExternalChanges() {
        try {
            const incomingData = this._loadDataFromFile(this._file);
            const mergedTasks = this._mergeTasks(this._tasks, incomingData.tasks);
            const mergedRoutine = this._mergeRoutine(this._routine, incomingData.routine);
            const changed =
                JSON.stringify(mergedTasks) !== JSON.stringify(this._tasks) ||
                JSON.stringify(mergedRoutine) !== JSON.stringify(this._routine);

            this._tasks = mergedTasks;
            this._routine = mergedRoutine;

            if (this._resetRoutineIfNeeded() || changed)
                this.save();
        } catch (error) {
            if (!this._isNotFoundError(error))
                console.error(`Edge Kanban: failed to merge external task changes: ${error.message}`);
        }
    }

    _taskTimestamp(task) {
        const updatedAt = Date.parse(task.updatedAt ?? task.createdAt ?? 0);
        const deletedAt = task.deletedAt ? Date.parse(task.deletedAt) : 0;

        return Math.max(
            Number.isNaN(updatedAt) ? 0 : updatedAt,
            Number.isNaN(deletedAt) ? 0 : deletedAt);
    }

    _mergeTasks(currentTasks, incomingTasks) {
        const merged = new Map();

        for (const task of currentTasks)
            merged.set(task.id, task);

        for (const task of incomingTasks) {
            const existing = merged.get(task.id);

            if (!existing || this._taskTimestamp(task) >= this._taskTimestamp(existing))
                merged.set(task.id, task);
        }

        return this._normalizeTaskOrder([...merged.values()]);
    }

    _routineItemTimestamp(item) {
        const updatedAt = Date.parse(item.updatedAt ?? item.createdAt ?? 0);
        const deletedAt = item.deletedAt ? Date.parse(item.deletedAt) : 0;

        return Math.max(
            Number.isNaN(updatedAt) ? 0 : updatedAt,
            Number.isNaN(deletedAt) ? 0 : deletedAt);
    }

    _mergeRoutine(currentRoutine, incomingRoutine) {
        const merged = new Map();
        const currentResetDate = this._normalizeDayKey(currentRoutine?.resetDate) ?? this._todayKey();
        const incomingResetDate = this._normalizeDayKey(incomingRoutine?.resetDate) ?? this._todayKey();

        for (const item of currentRoutine?.items ?? [])
            merged.set(item.id, item);

        for (const item of incomingRoutine?.items ?? []) {
            const existing = merged.get(item.id);

            if (!existing || this._routineItemTimestamp(item) >= this._routineItemTimestamp(existing))
                merged.set(item.id, item);
        }

        return {
            resetDate: currentResetDate > incomingResetDate ? currentResetDate : incomingResetDate,
            items: this._normalizeRoutineOrder([...merged.values()]),
        };
    }

    _loadLegacyDataIfPossible() {
        if (this._getStorageMode() !== DEFAULT_STORAGE_MODE)
            return this._createEmptyData();

        const legacyFile = Gio.File.new_for_path(this._getLegacyStoragePath());

        if (legacyFile.get_path() === this.path)
            return this._createEmptyData();

        try {
            return this._loadDataFromFile(legacyFile);
        } catch (error) {
            if (!this._isNotFoundError(error))
                console.error(`Edge Kanban: failed to migrate legacy tasks: ${error.message}`);

            return this._createEmptyData();
        }
    }

    save() {
        try {
            this._ensureDirectory();
            const contents = JSON.stringify({
                version: TASKS_VERSION,
                tasks: this._tasks,
                routine: this._routine,
            }, null, 2);

            this._file.replace_contents(
                contents,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null);
        } catch (error) {
            console.error(`Edge Kanban: failed to save tasks: ${error.message}`);
        }
    }

    _normalizeData(data) {
        return {
            tasks: this._normalizeTasks(data),
            routine: this._normalizeRoutine(data),
        };
    }

    _createEmptyData() {
        return {
            tasks: [],
            routine: this._createEmptyRoutine(),
        };
    }

    _createEmptyRoutine() {
        return {
            resetDate: this._todayKey(),
            items: [],
        };
    }

    _normalizeRoutine(data) {
        const rawRoutine = data?.routine;
        const rawItems = Array.isArray(rawRoutine) ? rawRoutine : rawRoutine?.items;

        if (!Array.isArray(rawItems))
            return this._createEmptyRoutine();

        const normalizedItems = rawItems
            .filter(item => typeof item?.title === 'string')
            .map((item, index) => {
                return {
                    id: String(item.id ?? this._createId()),
                    title: item.title.trim(),
                    checked: item.checked === true,
                    order: this._normalizeOrder(item.order, index),
                    createdAt: this._normalizeDate(item.createdAt),
                    updatedAt: this._normalizeDate(item.updatedAt ?? item.createdAt),
                    deletedAt: this._normalizeNullableDate(item.deletedAt),
                };
            })
            .filter(item => item.title.length > 0);

        return {
            resetDate: this._normalizeDayKey(rawRoutine?.resetDate) ?? this._todayKey(),
            items: this._normalizeRoutineOrder(normalizedItems),
        };
    }

    _normalizeDayKey(value) {
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
            return value;

        return null;
    }

    _todayKey() {
        return GLib.DateTime.new_now_local().format('%Y-%m-%d');
    }

    _normalizeTasks(data) {
        const rawTasks = Array.isArray(data) ? data : data?.tasks;

        if (!Array.isArray(rawTasks))
            return [];

        const statusCounts = new Map();

        const normalizedTasks = rawTasks
            .filter(task => {
                return typeof task?.title === 'string' &&
                    VALID_STATUSES.has(task?.status);
            })
            .map(task => {
                const fallbackOrder = statusCounts.get(task.status) ?? 0;
                const order = this._normalizeOrder(task.order, fallbackOrder);

                statusCounts.set(task.status, fallbackOrder + 1);

                return {
                    id: String(task.id ?? this._createId()),
                    title: task.title.trim(),
                    status: task.status,
                    order,
                    notes: this._normalizeNotes(task.notes),
                    createdAt: this._normalizeDate(task.createdAt),
                    updatedAt: this._normalizeDate(task.updatedAt ?? task.createdAt),
                    deletedAt: this._normalizeNullableDate(task.deletedAt),
                };
            })
            .filter(task => task.title.length > 0);

        return this._normalizeTaskOrder(normalizedTasks);
    }

    _normalizeDate(value) {
        if (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
            return value;

        return new Date().toISOString();
    }

    _normalizeNullableDate(value) {
        if (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
            return value;

        return null;
    }

    _normalizeNotes(value) {
        return typeof value === 'string' ? value : '';
    }

    _normalizeOrder(value, fallback) {
        const order = Number(value);

        if (Number.isFinite(order))
            return order;

        return fallback;
    }

    _normalizeTaskOrder(tasks) {
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

    _normalizeRoutineOrder(items) {
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

    _resetRoutineIfNeeded() {
        const today = this._todayKey();

        if (this._routine.resetDate === today)
            return false;

        const now = new Date().toISOString();
        let changed = this._routine.resetDate !== today;

        this._routine.resetDate = today;

        for (const item of this._routine.items) {
            if (item.deletedAt || !item.checked)
                continue;

            item.checked = false;
            item.updatedAt = now;
            changed = true;
        }

        return changed;
    }

    _scheduleRoutineReset() {
        if (this._routineResetTimeoutId) {
            GLib.Source.remove(this._routineResetTimeoutId);
            this._routineResetTimeoutId = 0;
        }

        const now = GLib.DateTime.new_now_local();
        const tomorrow = now.add_days(1);
        const nextMidnight = GLib.DateTime.new_local(
            tomorrow.get_year(),
            tomorrow.get_month(),
            tomorrow.get_day_of_month(),
            0,
            0,
            2);
        const intervalMs = Math.max(1000, Math.floor(nextMidnight.difference(now) / 1000));

        this._routineResetTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            intervalMs,
            () => {
                this._routineResetTimeoutId = 0;

                if (this._resetRoutineIfNeeded()) {
                    this.save();
                    this._onChanged?.();
                }

                this._scheduleRoutineReset();

                return GLib.SOURCE_REMOVE;
            });
    }

    _createId() {
        return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }

    getTasks(status) {
        return this._tasks
            .filter(task => task.status === status && !task.deletedAt)
            .sort((a, b) => a.order - b.order);
    }

    _nextOrder(status) {
        const tasks = this.getTasks(status);
        const lastTask = tasks.at(-1);

        return lastTask ? lastTask.order + 1 : 0;
    }

    _compactColumnOrder(status, now) {
        this.getTasks(status).forEach((task, index) => {
            if (task.order === index)
                return;

            task.order = index;
            task.updatedAt = now;
        });
    }

    getRoutineItems() {
        if (this._resetRoutineIfNeeded())
            this.save();

        return this._routine.items
            .filter(item => !item.deletedAt)
            .sort((a, b) => a.order - b.order);
    }

    routineProgress() {
        const items = this.getRoutineItems();

        return {
            checked: items.filter(item => item.checked).length,
            total: items.length,
        };
    }

    _nextRoutineOrder() {
        const items = this.getRoutineItems();
        const lastItem = items.at(-1);

        return lastItem ? lastItem.order + 1 : 0;
    }

    addRoutineItem(title) {
        const cleanTitle = title.trim();

        if (!cleanTitle)
            return;

        this._resetRoutineIfNeeded();

        const now = new Date().toISOString();
        this._routine.items.push({
            id: this._createId(),
            title: cleanTitle,
            checked: false,
            order: this._nextRoutineOrder(),
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        });
        this.save();
    }

    toggleRoutineItem(itemId) {
        this._resetRoutineIfNeeded();

        const item = this._routine.items.find(routineItem => routineItem.id === itemId);

        if (!item || item.deletedAt)
            return;

        item.checked = !item.checked;
        item.updatedAt = new Date().toISOString();
        this.save();
    }

    deleteRoutineItem(itemId) {
        const item = this._routine.items.find(routineItem => routineItem.id === itemId);

        if (!item)
            return;

        const now = new Date().toISOString();
        item.deletedAt = now;
        item.updatedAt = now;
        this._routine.items = this._normalizeRoutineOrder(this._routine.items);
        this.save();
    }

    addTask(status, title) {
        const cleanTitle = title.trim();

        if (!cleanTitle)
            return;

        const now = new Date().toISOString();
        this._tasks.push({
            id: this._createId(),
            title: cleanTitle,
            status,
            order: this._nextOrder(status),
            notes: '',
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        });
        this.save();
    }

    moveTask(taskId, status) {
        const task = this._tasks.find(item => item.id === taskId);

        if (!task)
            return;

        const previousStatus = task.status;
        const now = new Date().toISOString();

        task.status = status;
        task.order = this._nextOrder(status);
        task.updatedAt = now;
        this._compactColumnOrder(previousStatus, now);
        this._compactColumnOrder(status, now);
        this.save();
    }

    reorderTask(taskId, status, targetIndex) {
        const task = this._tasks.find(item => item.id === taskId);

        if (!task || task.status !== status || task.deletedAt)
            return;

        const orderedTasks = this.getTasks(status);
        const currentIndex = orderedTasks.indexOf(task);
        const otherTasks = orderedTasks.filter(item => item.id !== taskId);
        const nextIndex = Math.max(0, Math.min(targetIndex, otherTasks.length));

        if (currentIndex === nextIndex)
            return;

        otherTasks.splice(nextIndex, 0, task);

        const now = new Date().toISOString();
        otherTasks.forEach((item, index) => {
            item.order = index;
            item.updatedAt = now;
        });
        this.save();
    }

    renameTask(taskId, title) {
        const task = this._tasks.find(item => item.id === taskId);
        const cleanTitle = title.trim();

        if (!task || !cleanTitle)
            return;

        task.title = cleanTitle;
        task.updatedAt = new Date().toISOString();
        this.save();
    }

    updateTaskNotes(taskId, notes) {
        const task = this._tasks.find(item => item.id === taskId);

        if (!task)
            return;

        task.notes = String(notes).trimEnd();
        task.updatedAt = new Date().toISOString();
        this.save();
    }

    deleteTask(taskId) {
        const task = this._tasks.find(item => item.id === taskId);

        if (!task)
            return;

        const now = new Date().toISOString();
        task.deletedAt = now;
        task.updatedAt = now;
        this.save();
    }

    count() {
        return this._tasks.filter(task => !task.deletedAt).length;
    }
}

class EdgeKanbanPanel extends St.BoxLayout {
    static {
        GObject.registerClass({
            GTypeName: PANEL_GTYPE_NAME,
        }, this);
    }

    constructor(extension, settings) {
        super({
            name: 'edge-kanban',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
        });

        this._settings = settings;
        this._store = new TaskStore(extension, settings, () => {
            this._selectedTaskId = null;
            this._editingTaskId = null;
            this._editingNotesTaskId = null;
            this._addingRoutine = false;

            if (this._board)
                this._renderBoard();
        });
        this._interfaceSettings = this._createInterfaceSettings();
        this._selectedTaskId = null;
        this._editingTaskId = null;
        this._editingNotesTaskId = null;
        this._addingRoutine = false;
        this._addingStatus = null;
        this._draggingTaskId = null;
        this._activeDragSource = null;
        this._columnLists = new Map();
        this._hideTimeoutId = 0;
        this._standupStatusTimeoutId = 0;
        this._chromeTarget = null;
        this._chromeOptions = {
            affectsStruts: false,
            trackFullscreen: true,
        };
        this._isOpen = false;

        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('enter-event', this._onEnter.bind(this));
        this.connect('leave-event', this._onLeave.bind(this));

        this._settings.connectObject(
            'changed',
            () => this._syncSettings(),
            this);
        Main.layoutManager.connectObject(
            'monitors-changed',
            () => this._syncGeometry(false),
            this);
        this._interfaceSettings?.connectObject(
            'changed::accent-color',
            () => this._syncHandleStyle(),
            'changed::color-scheme',
            () => this._syncAppearance(),
            this);

        this._syncSettings();
    }

    _createInterfaceSettings() {
        try {
            return new Gio.Settings({
                schema_id: 'org.gnome.desktop.interface',
            });
        } catch (error) {
            console.error(`Edge Kanban: failed to read GNOME interface settings: ${error.message}`);
            return null;
        }
    }

    _syncSettings() {
        this._edge = this._readEdge();
        this._monitorMode = this._readMonitorMode();
        this._sideSize = this._settings.get_int('side-size');
        this._barSize = this._settings.get_int('bar-size');
        this._handleSize = this._settings.get_int('handle-size');
        this._handleCoverage = this._readHandleCoverage();
        this._handleMode = this._readHandleMode();
        this._hideDelayMs = this._settings.get_int('hide-delay-ms');
        this._backgroundMode = this._readBackgroundMode();
        this._backgroundColor = this._readBackgroundColor();
        this._store.reloadFromSettings();

        this._buildChrome();
        this._renderBoard();
        this._syncGeometry(false);
    }

    _readEdge() {
        const edge = this._settings.get_string('edge');
        return VALID_EDGES.has(edge) ? edge : 'left';
    }

    _isSideEdge() {
        return this._edge === 'left' || this._edge === 'right';
    }

    _readMonitorMode() {
        try {
            const mode = this._settings.get_string('monitor-mode');

            return VALID_MONITOR_MODES.has(mode) ? mode : DEFAULT_MONITOR_MODE;
        } catch (error) {
            return DEFAULT_MONITOR_MODE;
        }
    }

    _readHandleMode() {
        try {
            const mode = this._settings.get_string('handle-mode');
            return VALID_HANDLE_MODES.has(mode) ? mode : DEFAULT_HANDLE_MODE;
        } catch (error) {
            return DEFAULT_HANDLE_MODE;
        }
    }

    _readHandleCoverage() {
        try {
            const coverage = this._settings.get_int('handle-coverage');

            return Math.max(10, Math.min(100, coverage));
        } catch (error) {
            return DEFAULT_HANDLE_COVERAGE;
        }
    }

    _readBackgroundMode() {
        try {
            const mode = this._settings.get_string('background-mode');
            return VALID_BACKGROUND_MODES.has(mode) ? mode : DEFAULT_BACKGROUND_MODE;
        } catch (error) {
            return DEFAULT_BACKGROUND_MODE;
        }
    }

    _readBackgroundColor() {
        try {
            const color = this._settings.get_string('background-color').trim();
            return this._parseHexColor(color) ? color : DEFAULT_BACKGROUND_COLOR;
        } catch (error) {
            return DEFAULT_BACKGROUND_COLOR;
        }
    }

    _parseHexColor(color) {
        const match = /^#?([0-9a-fA-F]{6})$/.exec(color);

        if (!match)
            return null;

        const value = match[1];

        return {
            red: parseInt(value.slice(0, 2), 16),
            green: parseInt(value.slice(2, 4), 16),
            blue: parseInt(value.slice(4, 6), 16),
        };
    }

    _isDarkColor({red, green, blue}) {
        return (red * 0.299 + green * 0.587 + blue * 0.114) < 150;
    }

    _prefersDarkTheme() {
        try {
            return this._interfaceSettings?.get_string('color-scheme') === 'prefer-dark';
        } catch (error) {
            console.error(`Edge Kanban: failed to read color scheme: ${error.message}`);
            return false;
        }
    }

    _getAppearance() {
        switch (this._backgroundMode) {
        case 'transparent':
            return {
                surface: 'transparent',
                tone: 'dark',
                modeClass: 'transparent',
            };
        case 'theme': {
            const dark = this._prefersDarkTheme();

            return {
                surface: dark ? THEME_DARK_SURFACE : THEME_LIGHT_SURFACE,
                tone: dark ? 'dark' : 'light',
                modeClass: 'theme',
            };
        }
        case 'custom': {
            const color = this._parseHexColor(this._backgroundColor);

            if (!color) {
                return {
                    surface: LIGHT_SURFACE,
                    tone: 'light',
                    modeClass: 'off-white',
                };
            }

            return {
                surface: `rgba(${color.red}, ${color.green}, ${color.blue}, 0.94)`,
                tone: this._isDarkColor(color) ? 'dark' : 'light',
                modeClass: 'custom',
            };
        }
        case 'off-white':
        default:
            return {
                surface: LIGHT_SURFACE,
                tone: 'light',
                modeClass: 'off-white',
            };
        }
    }

    _syncRootStyleClass() {
        const appearance = this._getAppearance();

        this.style_class = [
            'edge-kanban-root',
            `edge-kanban-${this._edge}`,
            `edge-kanban-tone-${appearance.tone}`,
            `edge-kanban-bg-${appearance.modeClass}`,
        ].join(' ');
    }

    _syncAppearance() {
        if (!this._surface)
            return;

        const appearance = this._getAppearance();

        this._syncRootStyleClass();
        this._surface.style = `background-color: ${appearance.surface};`;
    }

    _buildChrome() {
        this._untrackChromeTarget();
        this.destroy_all_children();
        this.remove_all_transitions();

        const isSideEdge = this._isSideEdge();
        this.orientation = isSideEdge
            ? Clutter.Orientation.HORIZONTAL
            : Clutter.Orientation.VERTICAL;
        this._syncRootStyleClass();

        this._surface = new St.BoxLayout({
            style_class: 'edge-kanban-surface',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        this._handle = new St.Widget({
            style_class: 'edge-kanban-handle',
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._handle.connect('enter-event', this._onHandleEnter.bind(this));

        if (this._edge === 'left' || this._edge === 'top')
            this.add_child(this._handle);

        this.add_child(this._surface);

        if (this._edge === 'right' || this._edge === 'bottom')
            this.add_child(this._handle);

        this._buildHeader();

        this._routineBox = new St.BoxLayout({
            style_class: 'edge-kanban-routine',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._surface.add_child(this._routineBox);

        this._board = new St.BoxLayout({
            style_class: `edge-kanban-board ${isSideEdge ? 'edge-kanban-board-side' : 'edge-kanban-board-bar'}`,
            orientation: isSideEdge
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: true,
        });
        this._surface.add_child(this._board);
        this._syncAppearance();
        this._syncHandleStyle();
    }

    _syncHandleStyle() {
        if (!this._handle)
            return;

        if (this._handleMode === 'transparent' ||
            (this._handleMode === 'auto' && this._isOpen)) {
            this._handle.style = 'background-color: transparent;';
            return;
        }

        const rgb = this._getAccentRgb();
        this._handle.style = `background-color: rgba(${rgb}, 0.72);`;
    }

    _getAccentRgb() {
        let accentName = 'blue';

        try {
            accentName = this._interfaceSettings?.get_string('accent-color') ?? accentName;
        } catch (error) {
            console.error(`Edge Kanban: failed to read accent color: ${error.message}`);
        }

        return ACCENT_COLORS[accentName] ?? ACCENT_COLORS.blue;
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'edge-kanban-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        const titleBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        titleBox.add_child(new St.Label({
            text: 'Tasks',
            style_class: 'edge-kanban-title',
            x_expand: true,
        }));

        this._taskCount = new St.Label({
            style_class: 'edge-kanban-total-count',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._standupStatus = new St.Label({
            style_class: 'edge-kanban-standup-status',
            y_align: Clutter.ActorAlign.CENTER,
        });

        header.add_child(titleBox);
        header.add_child(this._taskCount);
        header.add_child(this._standupStatus);
        header.add_child(this._createIconButton({
            iconName: 'edit-copy-symbolic',
            accessibleName: 'Copy standup update',
            callback: () => this._copyStandupMarkdown(),
            extraClass: 'edge-kanban-standup-button',
            iconSize: 14,
        }));
        this._surface.add_child(header);
    }

    _renderBoard() {
        if (!this._board)
            return;

        this._renderRoutine();
        this._clearTaskDropIndicator();
        this._taskCount.text = String(this._store.count());
        this._board.destroy_all_children();
        this._columnLists = new Map();

        for (const column of COLUMN_DEFS)
            this._board.add_child(this._createColumn(column));
    }

    _renderRoutine() {
        if (!this._routineBox)
            return;

        const items = this._store.getRoutineItems();
        const progress = this._store.routineProgress();

        this._routineBox.destroy_all_children();

        const header = new St.BoxLayout({
            style_class: 'edge-kanban-routine-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        header.add_child(new St.Label({
            text: 'Daily Routine',
            style_class: 'edge-kanban-routine-heading',
            x_expand: true,
        }));
        header.add_child(new St.Label({
            text: `${progress.checked}/${progress.total}`,
            style_class: 'edge-kanban-routine-count',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(this._createIconButton({
            iconName: 'list-add-symbolic',
            accessibleName: 'Add routine item',
            callback: () => this._toggleRoutineAddRow(),
            extraClass: 'edge-kanban-add-toggle',
            iconSize: 14,
        }));
        this._routineBox.add_child(header);

        if (this._addingRoutine)
            this._routineBox.add_child(this._createRoutineAddRow());

        if (items.length === 0)
            return;

        const list = new St.BoxLayout({
            style_class: 'edge-kanban-routine-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        for (const item of items)
            list.add_child(this._createRoutineItem(item));

        this._routineBox.add_child(list);
    }

    _createRoutineItem(item) {
        const checked = item.checked === true;
        const row = new St.BoxLayout({
            style_class: [
                'edge-kanban-routine-item',
                checked ? 'edge-kanban-routine-item-checked' : '',
            ].join(' '),
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        const checkButton = this._createIconButton({
            iconName: checked ? 'checkbox-checked-symbolic' : 'checkbox-symbolic',
            accessibleName: checked ? 'Mark routine item incomplete' : 'Mark routine item complete',
            callback: () => this._toggleRoutineItem(item.id),
            extraClass: 'edge-kanban-routine-check',
            iconSize: 15,
        });

        if (checked)
            checkButton.style = `color: rgba(${this._getAccentRgb()}, 0.92);`;

        row.add_child(checkButton);

        const title = new St.Label({
            text: item.title,
            style_class: 'edge-kanban-routine-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.line_wrap = true;
        title.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        const titleButton = new St.Button({
            style_class: 'edge-kanban-routine-title-button',
            button_mask: St.ButtonMask.ONE,
            can_focus: true,
            x_expand: true,
            child: title,
        });
        titleButton.accessible_name = checked ? 'Mark routine item incomplete' : 'Mark routine item complete';
        titleButton.connect('clicked', () => this._toggleRoutineItem(item.id));

        row.add_child(titleButton);
        row.add_child(this._createIconButton({
            iconName: 'user-trash-symbolic',
            accessibleName: 'Delete routine item',
            callback: () => this._deleteRoutineItem(item.id),
            extraClass: 'edge-kanban-routine-delete edge-kanban-delete-button',
            iconSize: 13,
        }));

        return row;
    }

    _createColumn(column) {
        const tasks = this._store.getTasks(column.id);
        const columnBox = new St.BoxLayout({
            style_class: `edge-kanban-column edge-kanban-column-${column.id}`,
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        const header = new St.BoxLayout({
            style_class: 'edge-kanban-column-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        header.add_child(new St.Label({
            text: column.title,
            style_class: 'edge-kanban-column-title',
            x_expand: true,
        }));
        header.add_child(new St.Label({
            text: String(tasks.length),
            style_class: 'edge-kanban-count',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(this._createIconButton({
            iconName: 'list-add-symbolic',
            accessibleName: 'Add task',
            callback: () => this._toggleAddRow(column.id),
            extraClass: 'edge-kanban-add-toggle',
            iconSize: 14,
        }));
        columnBox.add_child(header);

        if (this._addingStatus === column.id)
            columnBox.add_child(this._createAddRow(column));

        const scrollView = new St.ScrollView({
            style_class: 'edge-kanban-scroll vfade',
            x_expand: true,
            y_expand: true,
        });
        const cardList = new St.BoxLayout({
            style_class: 'edge-kanban-card-list',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x_expand: true,
        });
        cardList._delegate = {
            handleDragOver: source => this._handleTaskDragOver(source, column.id),
            acceptDrop: source => this._acceptTaskDrop(source, column.id),
        };
        this._columnLists.set(column.id, cardList);

        if (tasks.length === 0) {
            cardList.add_child(new St.Label({
                text: 'No tasks',
                style_class: 'edge-kanban-empty',
                x_expand: true,
            }));
        } else {
            for (const task of tasks)
                cardList.add_child(this._createTaskCard(task));
        }

        scrollView.set_child(cardList);
        columnBox.add_child(scrollView);

        return columnBox;
    }

    _createTaskCard(task) {
        const selected = this._selectedTaskId === task.id;
        const editing = this._editingTaskId === task.id;
        const expanded = selected && !editing;
        const item = new St.BoxLayout({
            style_class: [
                'edge-kanban-task-item',
                expanded ? 'edge-kanban-task-item-expanded' : '',
            ].join(' '),
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        item._edgeKanbanTaskId = task.id;

        const card = new St.BoxLayout({
            style_class: [
                'edge-kanban-card',
                `edge-kanban-card-${task.status}`,
                selected ? 'edge-kanban-card-selected' : '',
                this._draggingTaskId === task.id ? 'edge-kanban-card-dragging' : '',
            ].join(' '),
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        item.add_child(card);

        card.add_child(this._createDragHandle(task, item, card));
        card.add_child(new St.Widget({
            style_class: `edge-kanban-task-dot edge-kanban-task-dot-${task.status}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        if (editing) {
            const entry = this._createEditEntry(task);
            card.add_child(entry);
            card.add_child(this._createIconButton({
                iconName: 'object-select-symbolic',
                accessibleName: 'Save task',
                callback: () => this._saveEditTask(task.id, entry.get_text()),
                extraClass: 'edge-kanban-save-button',
                iconSize: 14,
            }));
            card.add_child(this._createIconButton({
                iconName: 'window-close-symbolic',
                accessibleName: 'Cancel edit',
                callback: () => this._cancelEditTask(),
                extraClass: 'edge-kanban-cancel-button',
                iconSize: 14,
            }));

            return item;
        }

        const title = new St.Label({
            text: task.title,
            style_class: 'edge-kanban-task-title',
            x_expand: true,
        });
        title.clutter_text.line_wrap = true;
        title.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        const titleButton = new St.Button({
            style_class: 'edge-kanban-task-button',
            button_mask: St.ButtonMask.ONE,
            can_focus: true,
            x_expand: true,
            child: title,
        });
        titleButton.connect('clicked', () => {
            this._editingTaskId = null;
            this._editingNotesTaskId = null;
            this._selectedTaskId = selected ? null : task.id;
            this._renderBoard();
        });
        card.add_child(titleButton);

        if (selected) {
            this._addInlineTaskActions(card, task);
            item.add_child(this._createNotesDrawer(task));
        }

        return item;
    }

    _createDragHandle(task, item, card) {
        const icon = new St.Icon({
            icon_name: 'view-more-symbolic',
            icon_size: 12,
            style_class: 'edge-kanban-drag-handle-icon',
        });
        const handle = new St.Button({
            style_class: 'edge-kanban-drag-handle',
            button_mask: St.ButtonMask.ONE,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: icon,
        });

        const dragSource = {
            panel: this,
            taskId: task.id,
            status: task.status,
            actor: item,
            card,
            getDragActorSource: () => card,
        };

        handle.accessible_name = 'Reorder task';
        handle._delegate = dragSource;

        const draggable = DND.makeDraggable(handle, {
            restoreOnSuccess: true,
        });
        draggable.connect('drag-begin',
            () => this._beginShellTaskDrag(dragSource));
        draggable.connect('drag-cancelled',
            () => this._clearShellTaskDrag());
        draggable.connect('drag-end',
            () => this._clearShellTaskDrag());

        return handle;
    }

    _isTaskDragSource(source, status) {
        return source?.panel === this &&
            typeof source.taskId === 'string' &&
            source.status === status;
    }

    _beginShellTaskDrag(source) {
        this._cancelHideTimeout();
        this._selectedTaskId = null;
        this._editingTaskId = null;
        this._editingNotesTaskId = null;
        this._addingStatus = null;
        this._draggingTaskId = source.taskId;
        this._activeDragSource = source;
        source.card?.add_style_class_name('edge-kanban-card-dragging');
    }

    _getTaskActors(status) {
        const cardList = this._columnLists.get(status);

        if (!cardList)
            return [];

        return cardList.get_children()
            .filter(actor => actor._edgeKanbanTaskId);
    }

    _getTaskDropIndex(status, stageY, taskId) {
        const actors = this._getTaskActors(status)
            .filter(actor => actor._edgeKanbanTaskId !== taskId);
        let index = 0;

        for (const actor of actors) {
            const [, actorY] = actor.get_transformed_position();

            if (stageY > actorY + actor.height / 2)
                index += 1;
        }

        return Math.max(0, Math.min(index, actors.length));
    }

    _clearTaskDropIndicator() {
        if (!this._dropIndicator)
            return;

        const parent = this._dropIndicator.get_parent();

        if (parent)
            parent.remove_child(this._dropIndicator);

        this._dropIndicatorParent = null;
        this._dropIndicatorStatus = null;
        this._dropIndicatorIndex = -1;
    }

    _syncTaskDropIndicator(status, index, taskId) {
        const cardList = this._columnLists.get(status);

        if (!cardList)
            return;

        const actors = this._getTaskActors(status)
            .filter(actor => actor._edgeKanbanTaskId !== taskId);
        const rgb = this._getAccentRgb();

        if (!this._dropIndicator) {
            this._dropIndicator = new St.Widget({
                style_class: 'edge-kanban-drop-indicator',
                x_expand: true,
            });
        }

        this._dropIndicator.style = `background-color: rgba(${rgb}, 0.86);`;

        if (this._dropIndicatorParent === cardList &&
            this._dropIndicatorStatus === status &&
            this._dropIndicatorIndex === index)
            return;

        const currentParent = this._dropIndicator.get_parent();

        if (currentParent)
            currentParent.remove_child(this._dropIndicator);

        if (actors.length === 0 || index >= actors.length)
            cardList.insert_child_above(this._dropIndicator, null);
        else
            cardList.insert_child_below(this._dropIndicator, actors[index]);

        this._dropIndicatorParent = cardList;
        this._dropIndicatorStatus = status;
        this._dropIndicatorIndex = index;
    }

    _handleTaskDragOver(source, status) {
        if (!this._isTaskDragSource(source, status))
            return DND.DragMotionResult.NO_DROP;

        const [, stageY] = global.get_pointer();
        const index = this._getTaskDropIndex(status, stageY, source.taskId);

        this._dropTargetStatus = status;
        this._dropTargetIndex = index;
        this._syncTaskDropIndicator(status, index, source.taskId);

        return DND.DragMotionResult.MOVE_DROP;
    }

    _acceptTaskDrop(source, status) {
        if (!this._isTaskDragSource(source, status))
            return false;

        const targetIndex = this._dropTargetStatus === status
            ? this._dropTargetIndex
            : this._store.getTasks(status).findIndex(task => task.id === source.taskId);

        this._clearShellTaskDrag();
        this._store.reorderTask(source.taskId, status, targetIndex);
        this._renderBoard();

        return true;
    }

    _clearShellTaskDrag() {
        this._clearTaskDropIndicator();
        this._activeDragSource?.card?.remove_style_class_name('edge-kanban-card-dragging');
        this._activeDragSource = null;
        this._draggingTaskId = null;
        this._dropTargetStatus = null;
        this._dropTargetIndex = -1;
    }

    _createNotesDrawer(task) {
        const drawer = new St.BoxLayout({
            style_class: 'edge-kanban-notes-drawer',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        if (this._editingNotesTaskId === task.id) {
            const entry = this._createNotesEntry(task);
            const actions = new St.BoxLayout({
                style_class: 'edge-kanban-notes-actions',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_align: Clutter.ActorAlign.END,
            });

            actions.add_child(this._createIconButton({
                iconName: 'object-select-symbolic',
                accessibleName: 'Save note',
                callback: () => this._saveTaskNotes(task.id, entry.get_text()),
                extraClass: 'edge-kanban-save-button',
                iconSize: 14,
            }));
            actions.add_child(this._createIconButton({
                iconName: 'window-close-symbolic',
                accessibleName: 'Cancel note edit',
                callback: () => this._cancelEditNotes(),
                extraClass: 'edge-kanban-cancel-button',
                iconSize: 14,
            }));

            drawer.add_child(entry);
            drawer.add_child(actions);

            return drawer;
        }

        if ((task.notes ?? '').trim()) {
            const noteText = new St.Label({
                text: task.notes,
                style_class: 'edge-kanban-notes-text',
                x_expand: true,
            });
            noteText.clutter_text.line_wrap = true;
            noteText.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            noteText.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            drawer.add_child(noteText);

            const actions = new St.BoxLayout({
                style_class: 'edge-kanban-notes-actions',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_align: Clutter.ActorAlign.END,
            });
            actions.add_child(this._createIconButton({
                iconName: 'document-edit-symbolic',
                accessibleName: 'Edit note',
                callback: () => this._startEditNotes(task.id),
                extraClass: 'edge-kanban-edit-button',
                iconSize: 14,
            }));
            drawer.add_child(actions);

            return drawer;
        }

        const addButton = new St.Button({
            style_class: 'edge-kanban-notes-add',
            button_mask: St.ButtonMask.ONE,
            can_focus: true,
            child: new St.Label({
                text: 'Add note',
                style_class: 'edge-kanban-notes-add-label',
            }),
        });
        addButton.accessible_name = 'Add note';
        addButton.connect('clicked', () => this._startEditNotes(task.id));
        drawer.add_child(addButton);

        return drawer;
    }

    _createNotesEntry(task) {
        const entry = new St.Entry({
            style_class: 'edge-kanban-notes-entry',
            text: task.notes ?? '',
            hint_text: 'Add note',
            can_focus: true,
            x_expand: true,
        });

        entry.clutter_text.single_line_mode = false;
        entry.clutter_text.line_wrap = true;
        entry.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        entry.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        entry.clutter_text.activatable = false;

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (entry.get_stage())
                entry.clutter_text.grab_key_focus();

            return GLib.SOURCE_REMOVE;
        });

        return entry;
    }

    _createEditEntry(task) {
        const entry = new St.Entry({
            style_class: 'edge-kanban-edit-entry',
            text: task.title,
            can_focus: true,
            x_expand: true,
        });
        entry.clutter_text.connect('activate',
            () => this._saveEditTask(task.id, entry.get_text()));
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (entry.get_stage()) {
                entry.clutter_text.set_selection(0, -1);
                entry.clutter_text.grab_key_focus();
            }

            return GLib.SOURCE_REMOVE;
        });

        return entry;
    }

    _addInlineTaskActions(card, task) {
        const currentIndex = COLUMN_DEFS.findIndex(column => column.id === task.status);
        const previous = COLUMN_DEFS[currentIndex - 1];
        const next = COLUMN_DEFS[currentIndex + 1];

        card.add_child(this._createIconButton({
            iconName: 'document-edit-symbolic',
            accessibleName: 'Edit task',
            callback: () => this._startEditTask(task.id),
            extraClass: 'edge-kanban-edit-button',
            iconSize: 14,
        }));

        if (previous) {
            card.add_child(this._createIconButton({
                iconName: 'go-previous-symbolic',
                accessibleName: 'Move left',
                callback: () => this._moveTask(task.id, previous.id),
                iconSize: 14,
            }));
        }

        if (next) {
            card.add_child(this._createIconButton({
                iconName: 'go-next-symbolic',
                accessibleName: 'Move right',
                callback: () => this._moveTask(task.id, next.id),
                iconSize: 14,
            }));
        }

        card.add_child(this._createIconButton({
            iconName: 'user-trash-symbolic',
            accessibleName: 'Delete task',
            callback: () => this._deleteTask(task.id),
            extraClass: 'edge-kanban-delete-button',
            iconSize: 14,
        }));
    }

    _createIconButton({
        iconName,
        accessibleName,
        callback,
        extraClass = '',
        iconSize = ICON_SIZE,
    }) {
        const icon = new St.Icon({
            icon_name: iconName,
            icon_size: iconSize,
            style_class: 'edge-kanban-button-icon',
        });
        const button = new St.Button({
            style_class: `edge-kanban-icon-button ${extraClass}`,
            button_mask: St.ButtonMask.ONE,
            can_focus: true,
            child: icon,
        });
        button.accessible_name = accessibleName;
        button.connect('clicked', callback);

        return button;
    }

    _createStandupMarkdown() {
        const lines = [
            `*Standup - ${GLib.DateTime.new_now_local().format('%Y-%m-%d')}*`,
        ];

        for (const column of COLUMN_DEFS) {
            const tasks = this._store.getTasks(column.id);

            lines.push('', `*${column.title}*`);

            if (tasks.length === 0) {
                lines.push('- None');
                continue;
            }

            for (const task of tasks) {
                lines.push(`- ${task.title}`);

                const notes = (task.notes ?? '').trim();

                if (!notes)
                    continue;

                for (const noteLine of notes.split('\n'))
                    lines.push(`  > ${noteLine.trimEnd() || ' '}`);
            }
        }

        return lines.join('\n');
    }

    _copyTextToClipboard(text) {
        const selection = global.display.get_selection();
        const source = Meta.SelectionSourceMemory.new(
            'text/plain;charset=utf-8',
            GLib.Bytes.new(text));

        selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
    }

    _setStandupStatus(message) {
        if (!this._standupStatus)
            return;

        if (this._standupStatusTimeoutId) {
            GLib.Source.remove(this._standupStatusTimeoutId);
            this._standupStatusTimeoutId = 0;
        }

        this._standupStatus.text = message;

        if (!message)
            return;

        this._standupStatusTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1600,
            () => {
                this._standupStatusTimeoutId = 0;

                if (this._standupStatus)
                    this._standupStatus.text = '';

                return GLib.SOURCE_REMOVE;
            });
    }

    _copyStandupMarkdown() {
        try {
            this._copyTextToClipboard(this._createStandupMarkdown());
            this._setStandupStatus('Copied');
        } catch (error) {
            console.error(`Edge Kanban: failed to copy standup markdown: ${error.message}`);
            this._setStandupStatus('Copy failed');
        }
    }

    _toggleAddRow(status) {
        this._selectedTaskId = null;
        this._editingTaskId = null;
        this._editingNotesTaskId = null;
        this._addingRoutine = false;
        this._addingStatus = this._addingStatus === status ? null : status;
        this._renderBoard();
    }

    _toggleRoutineAddRow() {
        this._selectedTaskId = null;
        this._editingTaskId = null;
        this._editingNotesTaskId = null;
        this._addingStatus = null;
        this._addingRoutine = !this._addingRoutine;
        this._renderBoard();
    }

    _createRoutineAddRow() {
        const row = new St.BoxLayout({
            style_class: 'edge-kanban-routine-add-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        const entry = new St.Entry({
            style_class: 'edge-kanban-routine-add-entry',
            hint_text: 'Add routine item',
            can_focus: true,
            x_expand: true,
        });

        const addRoutineItem = () => {
            const title = entry.get_text();

            if (!title.trim())
                return;

            this._addingRoutine = false;
            this._store.addRoutineItem(title);
            entry.set_text('');
            this._renderBoard();
        };

        entry.clutter_text.connect('activate', addRoutineItem);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (entry.get_stage())
                entry.clutter_text.grab_key_focus();

            return GLib.SOURCE_REMOVE;
        });
        row.add_child(entry);
        row.add_child(this._createIconButton({
            iconName: 'list-add-symbolic',
            accessibleName: 'Add routine item',
            callback: addRoutineItem,
            extraClass: 'edge-kanban-add-button',
        }));

        return row;
    }

    _createAddRow(column) {
        const row = new St.BoxLayout({
            style_class: 'edge-kanban-add-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        const entry = new St.Entry({
            style_class: 'edge-kanban-add-entry',
            hint_text: 'Add task',
            can_focus: true,
            x_expand: true,
        });

        const addTask = () => {
            const title = entry.get_text();

            if (!title.trim())
                return;

            this._selectedTaskId = null;
            this._editingTaskId = null;
            this._editingNotesTaskId = null;
            this._addingRoutine = false;
            this._addingStatus = null;
            this._store.addTask(column.id, title);
            entry.set_text('');
            this._renderBoard();
        };

        entry.clutter_text.connect('activate', addTask);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (entry.get_stage())
                entry.clutter_text.grab_key_focus();

            return GLib.SOURCE_REMOVE;
        });
        row.add_child(entry);
        row.add_child(this._createIconButton({
            iconName: 'list-add-symbolic',
            accessibleName: 'Add task',
            callback: addTask,
            extraClass: 'edge-kanban-add-button',
        }));

        return row;
    }

    _toggleRoutineItem(itemId) {
        this._store.toggleRoutineItem(itemId);
        this._renderBoard();
    }

    _deleteRoutineItem(itemId) {
        this._store.deleteRoutineItem(itemId);
        this._renderBoard();
    }

    _moveTask(taskId, status) {
        this._selectedTaskId = null;
        this._editingTaskId = null;
        this._editingNotesTaskId = null;
        this._addingRoutine = false;
        this._store.moveTask(taskId, status);
        this._renderBoard();
    }

    _startEditTask(taskId) {
        this._selectedTaskId = taskId;
        this._editingTaskId = taskId;
        this._editingNotesTaskId = null;
        this._addingRoutine = false;
        this._addingStatus = null;
        this._renderBoard();
    }

    _saveEditTask(taskId, title) {
        if (!title.trim())
            return;

        this._selectedTaskId = null;
        this._editingTaskId = null;
        this._editingNotesTaskId = null;
        this._addingRoutine = false;
        this._store.renameTask(taskId, title);
        this._renderBoard();
    }

    _cancelEditTask() {
        this._editingTaskId = null;
        this._renderBoard();
    }

    _deleteTask(taskId) {
        this._selectedTaskId = null;
        this._editingTaskId = null;
        this._editingNotesTaskId = null;
        this._addingRoutine = false;
        this._store.deleteTask(taskId);
        this._renderBoard();
    }

    _startEditNotes(taskId) {
        this._selectedTaskId = taskId;
        this._editingTaskId = null;
        this._editingNotesTaskId = taskId;
        this._addingRoutine = false;
        this._addingStatus = null;
        this._renderBoard();
    }

    _saveTaskNotes(taskId, notes) {
        this._editingNotesTaskId = null;
        this._store.updateTaskNotes(taskId, notes);
        this._renderBoard();
    }

    _cancelEditNotes() {
        this._editingNotesTaskId = null;
        this._renderBoard();
    }

    _isPointerOverHandle() {
        if (!this._handle)
            return false;

        const [pointerX, pointerY] = global.get_pointer();
        const [handleX, handleY] = this._handle.get_transformed_position();

        return pointerX >= handleX &&
            pointerX <= handleX + this._handle.width &&
            pointerY >= handleY &&
            pointerY <= handleY + this._handle.height;
    }

    _onEnter() {
        if (!this._isOpen && !this._isPointerOverHandle())
            return Clutter.EVENT_PROPAGATE;

        this._cancelHideTimeout();
        this._reveal();
        return Clutter.EVENT_PROPAGATE;
    }

    _onHandleEnter() {
        this._cancelHideTimeout();
        this._reveal();
        return Clutter.EVENT_PROPAGATE;
    }

    _onLeave() {
        this._queueHide();
        return Clutter.EVENT_PROPAGATE;
    }

    _queueHide() {
        this._cancelHideTimeout();
        this._hideTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._hideDelayMs,
            () => {
                this._hideTimeoutId = 0;
                this._hide();
                return GLib.SOURCE_REMOVE;
            });
    }

    preview() {
        this._cancelHideTimeout();
        this._reveal(false);
        this._hideTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            2200,
            () => {
                this._hideTimeoutId = 0;

                if (!this.hover)
                    this._hide();

                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelHideTimeout() {
        if (!this._hideTimeoutId)
            return;

        GLib.Source.remove(this._hideTimeoutId);
        this._hideTimeoutId = 0;
    }

    _getAnchorMonitor() {
        if (this._monitorMode !== 'outer-edge')
            return Main.layoutManager.primaryMonitor ?? Main.layoutManager.monitors?.[0] ?? null;

        return this._getOuterEdgeMonitor();
    }

    _getOuterEdgeMonitor() {
        const monitors = Main.layoutManager.monitors ?? [];
        const primary = Main.layoutManager.primaryMonitor;

        if (monitors.length === 0)
            return primary;

        const isPrimary = monitor => {
            return monitor === primary ||
                (primary &&
                    monitor.x === primary.x &&
                    monitor.y === primary.y &&
                    monitor.width === primary.width &&
                    monitor.height === primary.height);
        };
        let selected = monitors[0];

        for (const monitor of monitors) {
            let better = false;

            switch (this._edge) {
            case 'right':
                better = monitor.x + monitor.width > selected.x + selected.width;
                break;
            case 'top':
                better = monitor.y < selected.y;
                break;
            case 'bottom':
                better = monitor.y + monitor.height > selected.y + selected.height;
                break;
            case 'left':
            default:
                better = monitor.x < selected.x;
                break;
            }

            if (better || (!better && isPrimary(monitor) && !isPrimary(selected)))
                selected = monitor;
        }

        return selected;
    }

    _getHandleLength(monitor) {
        const edgeLength = this._isSideEdge() ? monitor.height : monitor.width;

        return Math.max(this._handleSize, Math.round(edgeLength * this._handleCoverage / 100));
    }

    _syncGeometry(animate) {
        const monitor = this._getAnchorMonitor();

        if (!monitor)
            return;

        const isSideEdge = this._isSideEdge();
        const handleLength = this._getHandleLength(monitor);
        const width = isSideEdge ? this._sideSize + this._handleSize : monitor.width;
        const height = isSideEdge ? monitor.height : this._barSize + this._handleSize;

        this.set_size(width, height);

        if (isSideEdge) {
            this._surface.set_size(this._sideSize, height);
            this._handle.set_size(this._handleSize, handleLength);
        } else {
            this._surface.set_size(width, this._barSize);
            this._handle.set_size(handleLength, this._handleSize);
        }

        if (this._isOpen)
            this._reveal(animate);
        else
            this._hide(animate);
    }

    _getShownPosition() {
        const monitor = this._getAnchorMonitor();

        switch (this._edge) {
        case 'right':
            return [monitor.x + monitor.width - this.width, monitor.y];
        case 'top':
            return [monitor.x, monitor.y];
        case 'bottom':
            return [monitor.x, monitor.y + monitor.height - this.height];
        case 'left':
        default:
            return [monitor.x, monitor.y];
        }
    }

    _getHiddenPosition() {
        return this._getShownPosition();
    }

    _getSurfaceTranslation(open) {
        if (open)
            return [0, 0];

        switch (this._edge) {
        case 'right':
            return [this._sideSize + this._handleSize, 0];
        case 'top':
            return [0, -this._barSize - this._handleSize];
        case 'bottom':
            return [0, this._barSize + this._handleSize];
        case 'left':
        default:
            return [-this._sideSize - this._handleSize, 0];
        }
    }

    _moveSurfaceTo([translationX, translationY], animate) {
        if (!this._surface)
            return;

        this._surface.remove_all_transitions();

        if (!animate) {
            this._surface.translation_x = translationX;
            this._surface.translation_y = translationY;
            return;
        }

        this._surface.ease({
            translation_x: translationX,
            translation_y: translationY,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _untrackChromeActor(actor) {
        if (!actor)
            return;

        try {
            Main.layoutManager.untrackChrome(actor);
        } catch (error) {
            // GNOME Shell throws if the actor was not tracked; that is harmless here.
        }
    }

    _untrackChromeTarget() {
        if (this._chromeTarget) {
            this._untrackChromeActor(this._chromeTarget);
            this._chromeTarget = null;
            return;
        }

        this._untrackChromeActor(this);
        this._untrackChromeActor(this._handle);
    }

    _syncChromeTracking() {
        if (!this.get_parent())
            return;

        const target = this._isOpen ? this : this._handle;

        if (!target || this._chromeTarget === target)
            return;

        this._untrackChromeTarget();

        try {
            Main.layoutManager.trackChrome(target, this._chromeOptions);
            this._chromeTarget = target;
        } catch (error) {
            console.error(`Edge Kanban: failed to track chrome input region: ${error.message}`);
        }
    }

    _syncInputReactivity() {
        this.reactive = this._isOpen;
        this.track_hover = this._isOpen;

        if (this._handle) {
            this._handle.reactive = true;
            this._handle.track_hover = true;
        }

        this._syncChromeTracking();
    }

    _reveal(animate = true) {
        this._isOpen = true;
        this._syncHandleStyle();
        this._syncInputReactivity();
        this._moveTo(this._getShownPosition(), animate);
        this._moveSurfaceTo(this._getSurfaceTranslation(true), animate);
    }

    _hide(animate = true) {
        this._isOpen = false;
        this._syncHandleStyle();
        this._syncInputReactivity();
        this._moveTo(this._getHiddenPosition(), animate);
        this._moveSurfaceTo(this._getSurfaceTranslation(false), animate);
    }

    _moveTo([x, y], animate) {
        this.remove_all_transitions();

        if (!animate) {
            this.set_position(x, y);
            return;
        }

        this.ease({
            x,
            y,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onDestroy() {
        this._clearShellTaskDrag();
        this._cancelHideTimeout();
        this._untrackChromeTarget();

        if (this._standupStatusTimeoutId) {
            GLib.Source.remove(this._standupStatusTimeoutId);
            this._standupStatusTimeoutId = 0;
        }

        this._store.destroy();
        this._settings.disconnectObject(this);
        this._interfaceSettings?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
    }
}

export class EdgeKanbanController {
    constructor(extension) {
        this._extension = extension;
    }

    enable() {
        this._settings = this._extension.getSettings();
        this._panel = new EdgeKanbanPanel(this._extension, this._settings);

        Main.layoutManager.addChrome(this._panel, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._panel._syncGeometry(false);
        this._panel.preview();
    }

    disable() {
        if (this._panel) {
            Main.layoutManager.removeChrome(this._panel);
            this._panel.destroy();
            this._panel = null;
        }

        this._settings = null;
    }
}
