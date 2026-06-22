import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class EdgeKanbanExtension extends Extension {
    enable() {
        this._loadToken = (this._loadToken ?? 0) + 1;
        const loadToken = this._loadToken;
        const implementationUri = GLib.filename_to_uri(
            GLib.build_filenamev([this.path, 'kanban.js']),
            null);

        import(`${implementationUri}?v=${GLib.get_monotonic_time()}`)
            .then(module => {
                if (this._loadToken !== loadToken)
                    return;

                this._controller = new module.EdgeKanbanController(this);
                this._controller.enable();
            })
            .catch(error => {
                console.error(`Edge Kanban: failed to load implementation: ${error.stack ?? error.message}`);
            });
    }

    disable() {
        this._loadToken = (this._loadToken ?? 0) + 1;

        if (this._controller) {
            this._controller.disable();
            this._controller = null;
        }
    }
}
