(function () {
    "use strict";

    var API_BASE = window.location.origin + "/admin/api";
    var state = {
        activeTab: "profiles",
        plugins: [],
        profiles: [],
        pluginMap: {},
        selectedProfileName: "",
        selectedProfileRaw: null,
        selectedProfileDraft: null,
        ui: {
            activePluginId: "",
            collapsedPlugins: {},
            adminSidebarCollapsed: false,
            profileSidebarCollapsed: false
        },
        loading: {
            boot: false,
            profile: false,
            save: false,
            reload: false
        }
    };

    var panelTitleEl = document.getElementById("panelTitle");
    var topbarMetaEl = document.getElementById("topbarMeta");
    var panelEl = document.getElementById("panel");
    var messageEl = document.getElementById("globalMessage");
    var appShellEl = document.getElementById("appShell");
    var adminSidebarToggleEl = document.getElementById("adminSidebarToggle");
    var profileSidebarToggleEl = document.getElementById("profileSidebarToggle");
    var themeToggleEl = document.getElementById("themeToggle");
    var tabButtons = Array.prototype.slice.call(document.querySelectorAll(".tab-button"));
    var THEME_STORAGE_KEY = "xnnehanglab-admin-theme";
    var ADMIN_SIDEBAR_STORAGE_KEY = "xnnehanglab-admin-sidebar-collapsed";
    var PROFILE_SIDEBAR_STORAGE_KEY = "xnnehanglab-profile-sidebar-collapsed";

    state.ui.adminSidebarCollapsed = loadBooleanPreference(ADMIN_SIDEBAR_STORAGE_KEY, false);
    state.ui.profileSidebarCollapsed = loadBooleanPreference(PROFILE_SIDEBAR_STORAGE_KEY, false);
    applyTheme(loadThemePreference());
    applyLayoutState();
    initialize();

    document.addEventListener("click", handleClick);
    document.addEventListener("change", handleChange);
    document.addEventListener("input", handleInput);

    async function initialize() {
        state.loading.boot = true;
        setMessage("正在加载 Profiles 和 Plugins...", "info");
        render();

        var results = await Promise.allSettled([fetchPlugins(), fetchProfiles()]);
        var pluginsResult = results[0];
        var profilesResult = results[1];

        if (pluginsResult.status === "fulfilled") {
            state.plugins = pluginsResult.value;
            state.pluginMap = buildPluginMap(state.plugins);
        } else {
            setMessage(getErrorMessage(pluginsResult.reason, "加载插件列表失败"), "error");
        }

        if (profilesResult.status === "fulfilled") {
            state.profiles = profilesResult.value;
        } else {
            setMessage(getErrorMessage(profilesResult.reason, "加载 profile 列表失败"), "error");
        }

        state.loading.boot = false;

        if (state.profiles.length > 0) {
            state.selectedProfileName = pickDefaultProfile(state.profiles);
            await loadProfile(state.selectedProfileName, false);
        } else {
            state.selectedProfileName = "";
            state.selectedProfileRaw = null;
            state.selectedProfileDraft = null;
            if (!state.plugins.length) {
                setMessage("未找到 profiles，plugins 列表也为空。", "warning");
            } else {
                setMessage("未找到任何 profile 文件。", "warning");
            }
            render();
        }
    }

    async function fetchPlugins() {
        return apiFetch("/plugins");
    }

    async function fetchProfiles() {
        return apiFetch("/profiles");
    }

    async function loadProfile(name, silent) {
        if (!name) {
            state.selectedProfileName = "";
            state.selectedProfileRaw = null;
            state.selectedProfileDraft = null;
            render();
            return;
        }

        state.loading.profile = true;
        if (!silent) {
            setMessage("正在加载 profile: " + name, "info");
        }
        render();

        try {
            var rawProfile = await apiFetch("/profiles/" + encodeURIComponent(name));
            state.selectedProfileName = name;
            state.selectedProfileRaw = rawProfile;
            state.selectedProfileDraft = createProfileDraft(rawProfile, state.pluginMap);
            state.ui.activePluginId = state.selectedProfileDraft.enabled[0] || "";
            topbarMetaEl.textContent = "Editing " + name;
            if (!silent) {
                clearMessage();
            }
        } catch (error) {
            setMessage(getErrorMessage(error, "加载 profile 失败"), "error");
        } finally {
            state.loading.profile = false;
            render();
        }
    }

    async function saveProfile(shouldReload) {
        if (!state.selectedProfileName || !state.selectedProfileDraft || state.loading.save || state.loading.reload) {
            return;
        }

        state.loading.save = true;
        if (shouldReload) {
            state.loading.reload = true;
        }
        setMessage(shouldReload ? "正在保存并重载 agent..." : "正在保存 profile...", "info");
        render();

        var payload = buildProfilePayload(state.selectedProfileRaw, state.selectedProfileDraft, state.pluginMap);

        try {
            await apiFetch("/profiles/" + encodeURIComponent(state.selectedProfileName), {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });
            state.selectedProfileRaw = deepClone(payload);

            if (!shouldReload) {
                setMessage("保存成功: " + state.selectedProfileName, "success");
                return;
            }

            try {
                await apiFetch("/agent/reload", {
                    method: "POST"
                });
                setMessage("保存成功，agent 已重载。", "success");
            } catch (reloadError) {
                setMessage(
                    "Profile 已保存，但重载失败: " + getErrorMessage(reloadError, "reload failed"),
                    "warning"
                );
            }
        } catch (error) {
            setMessage(getErrorMessage(error, "保存 profile 失败"), "error");
        } finally {
            state.loading.save = false;
            state.loading.reload = false;
            render();
        }
    }

    function buildPluginMap(plugins) {
        var map = {};
        for (var i = 0; i < plugins.length; i += 1) {
            map[plugins[i].id] = plugins[i];
        }
        return map;
    }

    function pickDefaultProfile(profiles) {
        return profiles.indexOf("baoqiao.toml") >= 0 ? "baoqiao.toml" : profiles[0];
    }

    function createProfileDraft(rawProfile, pluginMap) {
        var pluginsSection = isPlainObject(rawProfile && rawProfile.plugins) ? rawProfile.plugins : {};
        var enabled = Array.isArray(pluginsSection.enabled) ? pluginsSection.enabled.slice() : [];
        var rawOverrides = {};
        var values = {};
        var extraOverrides = {};
        var explicitFields = {};

        Object.keys(pluginsSection).forEach(function (key) {
            if (key !== "enabled" && isPlainObject(pluginsSection[key])) {
                rawOverrides[key] = deepClone(pluginsSection[key]);
            }
        });

        enabled.forEach(function (pluginId) {
            initializePluginDraft(pluginId, values, extraOverrides, explicitFields, rawOverrides, pluginMap);
        });

        return {
            enabled: enabled,
            values: values,
            extraOverrides: extraOverrides,
            explicitFields: explicitFields
        };
    }

    function initializePluginDraft(pluginId, values, extraOverrides, explicitFields, rawOverrides, pluginMap) {
        var pluginDef = pluginMap[pluginId] || createUnknownPluginDefinition(pluginId);
        var defaults = isPlainObject(pluginDef.config) ? deepClone(pluginDef.config) : {};
        var schema = isPlainObject(pluginDef.config_schema) ? pluginDef.config_schema : {};
        var override = isPlainObject(rawOverrides[pluginId]) ? deepClone(rawOverrides[pluginId]) : {};
        var schemaKeys = Object.keys(schema);

        if (schemaKeys.length === 0) {
            values[pluginId] = mergeObjects(defaults, override);
            extraOverrides[pluginId] = {};
            return;
        }

        var draftValues = {};
        var draftExtras = {};
        var draftExplicitFields = {};
        schemaKeys.forEach(function (field) {
            if (Object.prototype.hasOwnProperty.call(override, field)) {
                draftValues[field] = deepClone(override[field]);
                draftExplicitFields[field] = true;
            } else if (Object.prototype.hasOwnProperty.call(defaults, field)) {
                draftValues[field] = deepClone(defaults[field]);
            } else if (schema[field] && Object.prototype.hasOwnProperty.call(schema[field], "default")) {
                draftValues[field] = deepClone(schema[field].default);
            } else {
                draftValues[field] = emptyValueForSchemaField(schema[field]);
            }
        });

        Object.keys(override).forEach(function (field) {
            if (!Object.prototype.hasOwnProperty.call(schema, field)) {
                draftExtras[field] = deepClone(override[field]);
            }
        });

        values[pluginId] = draftValues;
        extraOverrides[pluginId] = draftExtras;
        explicitFields[pluginId] = draftExplicitFields;
    }

    function emptyValueForSchemaField(fieldSchema) {
        var type = fieldSchema && fieldSchema.type;
        if (type === "bool") {
            return false;
        }
        if (type === "int" || type === "float") {
            return "";
        }
        return "";
    }

    function createUnknownPluginDefinition(pluginId) {
        return {
            id: pluginId,
            plugin: {
                id: pluginId,
                name: pluginId,
                type: "unknown",
                description: "Installed plugin metadata is unavailable."
            },
            config: {},
            config_schema: {}
        };
    }

    function buildProfilePayload(rawProfile, draft, pluginMap) {
        var payload = isPlainObject(rawProfile) ? deepClone(rawProfile) : {};
        var existingPlugins = isPlainObject(payload.plugins) ? payload.plugins : {};
        var nextPlugins = {};

        Object.keys(existingPlugins).forEach(function (key) {
            var value = existingPlugins[key];
            if (key !== "enabled" && !isPlainObject(value)) {
                nextPlugins[key] = deepClone(value);
            }
        });

        nextPlugins.enabled = draft.enabled.slice();

        draft.enabled.forEach(function (pluginId) {
            var pluginDef = pluginMap[pluginId] || createUnknownPluginDefinition(pluginId);
            var schema = isPlainObject(pluginDef.config_schema) ? pluginDef.config_schema : {};
            var schemaKeys = Object.keys(schema);
            var serialized;

            if (schemaKeys.length === 0) {
                serialized = diffObject(draft.values[pluginId], pluginDef.config || {});
            } else {
                serialized = deepClone(draft.extraOverrides[pluginId] || {});
                schemaKeys.forEach(function (field) {
                    var currentValue = draft.values[pluginId] ? draft.values[pluginId][field] : undefined;
                    var defaultValue = getDefaultFieldValue(pluginDef, field);
                    var normalizedCurrent = normalizeNumberForSave(currentValue, schema[field]);
                    var keepExplicit =
                        Boolean(draft.explicitFields[pluginId]) &&
                        Boolean(draft.explicitFields[pluginId][field]);

                    if (normalizedCurrent === "" && schema[field] && (schema[field].type === "int" || schema[field].type === "float")) {
                        return;
                    }

                    if (keepExplicit || !deepEqual(normalizedCurrent, defaultValue)) {
                        serialized[field] = normalizedCurrent;
                    }
                });
            }

            if (isPlainObject(serialized) && Object.keys(serialized).length > 0) {
                nextPlugins[pluginId] = serialized;
            }
        });

        payload.plugins = nextPlugins;
        return payload;
    }

    function getDefaultFieldValue(pluginDef, field) {
        if (pluginDef && isPlainObject(pluginDef.config) && Object.prototype.hasOwnProperty.call(pluginDef.config, field)) {
            return deepClone(pluginDef.config[field]);
        }
        if (
            pluginDef &&
            isPlainObject(pluginDef.config_schema) &&
            isPlainObject(pluginDef.config_schema[field]) &&
            Object.prototype.hasOwnProperty.call(pluginDef.config_schema[field], "default")
        ) {
            return deepClone(pluginDef.config_schema[field].default);
        }
        return emptyValueForSchemaField(pluginDef && pluginDef.config_schema ? pluginDef.config_schema[field] : null);
    }

    function cleanupObject(value) {
        if (!isPlainObject(value)) {
            return {};
        }

        var cleaned = {};
        Object.keys(value).forEach(function (key) {
            if (typeof value[key] !== "undefined") {
                cleaned[key] = deepClone(value[key]);
            }
        });
        return cleaned;
    }

    function diffObject(currentValue, defaultValue) {
        var current = cleanupObject(currentValue);
        var defaults = isPlainObject(defaultValue) ? defaultValue : {};
        var diff = {};

        Object.keys(current).forEach(function (key) {
            if (!deepEqual(current[key], defaults[key])) {
                diff[key] = deepClone(current[key]);
            }
        });

        return diff;
    }

    function normalizeNumberForCompare(value, schemaField) {
        if (!schemaField || (schemaField.type !== "int" && schemaField.type !== "float")) {
            return value;
        }
        return normalizeNumberForSave(value, schemaField);
    }

    function normalizeNumberForSave(value, schemaField) {
        if (!schemaField || (schemaField.type !== "int" && schemaField.type !== "float")) {
            return value;
        }
        if (value === "" || value === null || typeof value === "undefined") {
            return "";
        }
        var parsed = schemaField.type === "int" ? parseInt(value, 10) : parseFloat(value);
        return Number.isNaN(parsed) ? "" : parsed;
    }

    async function apiFetch(path, options) {
        var response = await fetch(API_BASE + path, options || {});
        var text = await response.text();
        var data = null;

        if (text) {
            try {
                data = JSON.parse(text);
            } catch (error) {
                data = text;
            }
        }

        if (!response.ok) {
            var message = isPlainObject(data) && data.detail ? String(data.detail) : response.status + " " + response.statusText;
            throw new Error(message);
        }

        return data;
    }

    function handleClick(event) {
        var tabButton = event.target.closest("[data-tab]");
        if (tabButton) {
            state.activeTab = tabButton.getAttribute("data-tab");
            render();
            return;
        }

        var actionEl = event.target.closest("[data-action]");
        if (!actionEl) {
            return;
        }

        var action = actionEl.getAttribute("data-action");
        if (action === "add-plugin") {
            addSelectedPlugin();
            return;
        }
        if (action === "remove-plugin") {
            removePlugin(actionEl.getAttribute("data-plugin-id"));
            return;
        }
        if (action === "jump-plugin") {
            focusPlugin(actionEl.getAttribute("data-plugin-id"));
            return;
        }
        if (action === "toggle-plugin") {
            togglePluginCollapse(actionEl.getAttribute("data-plugin-id"));
            return;
        }
        if (action === "expand-all-plugins") {
            setAllPluginCollapse(false);
            return;
        }
        if (action === "collapse-all-plugins") {
            setAllPluginCollapse(true);
            return;
        }
        if (action === "save-profile") {
            saveProfile(false);
            return;
        }
        if (action === "save-reload") {
            saveProfile(true);
            return;
        }
        if (action === "reset-field") {
            resetSchemaField(actionEl.getAttribute("data-plugin-id"), actionEl.getAttribute("data-field"));
        }
    }

    function handleChange(event) {
        var target = event.target;

        if (target.id === "profileSelect") {
            loadProfile(target.value, false);
            return;
        }

        if (target.matches("[data-field-type='bool']")) {
            updateSchemaValue(target.getAttribute("data-plugin-id"), target.getAttribute("data-field"), target.checked);
            var textEl = target.parentElement ? target.parentElement.querySelector("span") : null;
            if (textEl) {
                textEl.textContent = target.checked ? "Enabled" : "Disabled";
            }
            return;
        }

        if (target.matches("[data-raw-plugin]")) {
            updateRawPluginConfig(target);
        }
    }

    function handleInput(event) {
        var target = event.target;
        if (target.matches("[data-field-type='str']")) {
            updateSchemaValue(target.getAttribute("data-plugin-id"), target.getAttribute("data-field"), target.value);
            return;
        }

        if (target.matches("[data-field-type='int'], [data-field-type='float']")) {
            updateSchemaValue(target.getAttribute("data-plugin-id"), target.getAttribute("data-field"), target.value);
        }
    }

    function addSelectedPlugin() {
        if (!state.selectedProfileDraft) {
            return;
        }
        var selectEl = document.getElementById("addPluginSelect");
        if (!selectEl || !selectEl.value) {
            return;
        }

        var pluginId = selectEl.value;
        if (state.selectedProfileDraft.enabled.indexOf(pluginId) >= 0) {
            return;
        }

        state.selectedProfileDraft.enabled.push(pluginId);
        initializePluginDraft(
            pluginId,
            state.selectedProfileDraft.values,
            state.selectedProfileDraft.extraOverrides,
            state.selectedProfileDraft.explicitFields,
            {},
            state.pluginMap
        );
        state.ui.activePluginId = pluginId;
        state.ui.collapsedPlugins[pluginId] = false;
        setMessage("已将插件加入当前 profile: " + pluginId, "info");
        render();
    }

    function removePlugin(pluginId) {
        if (!state.selectedProfileDraft || !pluginId) {
            return;
        }

        state.selectedProfileDraft.enabled = state.selectedProfileDraft.enabled.filter(function (id) {
            return id !== pluginId;
        });
        delete state.selectedProfileDraft.values[pluginId];
        delete state.selectedProfileDraft.extraOverrides[pluginId];
        delete state.selectedProfileDraft.explicitFields[pluginId];
        delete state.ui.collapsedPlugins[pluginId];
        if (state.ui.activePluginId === pluginId) {
            state.ui.activePluginId = state.selectedProfileDraft.enabled[0] || "";
        }
        setMessage("已从当前 profile 移除插件: " + pluginId, "info");
        render();
    }

    function focusPlugin(pluginId) {
        if (!pluginId) {
            return;
        }
        state.ui.activePluginId = pluginId;
        state.ui.collapsedPlugins[pluginId] = false;
        render();

        window.requestAnimationFrame(function () {
            var target = document.getElementById(pluginCardDomId(pluginId));
            if (target && typeof target.scrollIntoView === "function") {
                target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        });
    }

    function togglePluginCollapse(pluginId) {
        if (!pluginId) {
            return;
        }
        state.ui.collapsedPlugins[pluginId] = !Boolean(state.ui.collapsedPlugins[pluginId]);
        if (!state.ui.collapsedPlugins[pluginId]) {
            state.ui.activePluginId = pluginId;
        }
        render();
    }

    function setAllPluginCollapse(collapsed) {
        if (!state.selectedProfileDraft) {
            return;
        }
        state.selectedProfileDraft.enabled.forEach(function (pluginId) {
            state.ui.collapsedPlugins[pluginId] = collapsed;
        });
        if (!collapsed && state.selectedProfileDraft.enabled.length) {
            state.ui.activePluginId = state.selectedProfileDraft.enabled[0];
        }
        render();
    }

    function updateSchemaValue(pluginId, field, rawValue) {
        if (!state.selectedProfileDraft || !state.selectedProfileDraft.values[pluginId]) {
            return;
        }
        state.selectedProfileDraft.values[pluginId][field] = rawValue;
        state.selectedProfileDraft.explicitFields[pluginId] = state.selectedProfileDraft.explicitFields[pluginId] || {};
        state.selectedProfileDraft.explicitFields[pluginId][field] = true;
        updateFieldMessage(pluginId, field);
    }

    function updateFieldMessage(pluginId, field) {
        var pluginDef = state.pluginMap[pluginId] || createUnknownPluginDefinition(pluginId);
        var currentValue = state.selectedProfileDraft.values[pluginId][field];
        var defaultValue = getDefaultFieldValue(pluginDef, field);
        var schemaField = pluginDef.config_schema ? pluginDef.config_schema[field] : null;
        var isDefault = deepEqual(normalizeNumberForCompare(currentValue, schemaField), defaultValue);
        setMessage(
            pluginId + "." + field + (isDefault ? " 正在使用默认值。" : " 已写入当前编辑态，保存后生效。"),
            "info"
        );
    }

    function updateRawPluginConfig(textareaEl) {
        var pluginId = textareaEl.getAttribute("data-raw-plugin");
        if (!state.selectedProfileDraft || !pluginId) {
            return;
        }

        try {
            var parsed = textareaEl.value.trim() ? JSON.parse(textareaEl.value) : {};
            if (!isPlainObject(parsed)) {
                throw new Error("JSON root must be an object");
            }
            state.selectedProfileDraft.values[pluginId] = parsed;
            textareaEl.classList.remove("is-invalid");
            setMessage("已更新 " + pluginId + " 的原始 override。", "info");
        } catch (error) {
            textareaEl.classList.add("is-invalid");
            setMessage(pluginId + " 的 JSON 无法解析: " + error.message, "error");
        }
    }

    function resetSchemaField(pluginId, field) {
        if (!state.selectedProfileDraft || !state.selectedProfileDraft.values[pluginId]) {
            return;
        }
        state.selectedProfileDraft.values[pluginId][field] = getDefaultFieldValue(
            state.pluginMap[pluginId] || createUnknownPluginDefinition(pluginId),
            field
        );
        if (state.selectedProfileDraft.explicitFields[pluginId]) {
            delete state.selectedProfileDraft.explicitFields[pluginId][field];
        }
        setMessage("已恢复默认值: " + pluginId + "." + field, "info");
        render();
    }

    function render() {
        applyLayoutState();
        renderTabs();
        renderTopbar();

        if (state.activeTab === "profiles") {
            panelEl.innerHTML = renderProfilesTab();
            return;
        }
        if (state.activeTab === "plugins") {
            panelEl.innerHTML = renderPluginsTab();
            return;
        }
        panelEl.innerHTML = renderMarketTab();
    }

    function renderTabs() {
        tabButtons.forEach(function (button) {
            var isActive = button.getAttribute("data-tab") === state.activeTab;
            button.classList.toggle("is-active", isActive);
        });
    }

    function renderTopbar() {
        panelTitleEl.textContent = capitalize(state.activeTab);

        if (adminSidebarToggleEl) {
            adminSidebarToggleEl.textContent = state.ui.adminSidebarCollapsed ? "显示 Admin 侧栏" : "隐藏 Admin 侧栏";
            adminSidebarToggleEl.setAttribute("aria-pressed", String(!state.ui.adminSidebarCollapsed));
        }

        if (profileSidebarToggleEl) {
            profileSidebarToggleEl.textContent = state.ui.profileSidebarCollapsed ? "显示 Profile 侧栏" : "隐藏 Profile 侧栏";
            profileSidebarToggleEl.setAttribute("aria-pressed", String(!state.ui.profileSidebarCollapsed));
            profileSidebarToggleEl.disabled = state.activeTab !== "profiles";
        }

        if (state.loading.boot) {
            topbarMetaEl.textContent = "Loading admin data...";
            return;
        }

        if (state.activeTab === "profiles") {
            if (!state.profiles.length) {
                topbarMetaEl.textContent = "No profiles found";
                return;
            }
            if (state.loading.profile) {
                topbarMetaEl.textContent = "Loading " + state.selectedProfileName + "...";
                return;
            }
            var enabledCount = state.selectedProfileDraft ? state.selectedProfileDraft.enabled.length : 0;
            topbarMetaEl.textContent = state.selectedProfileName
                ? state.selectedProfileName + " · " + enabledCount + " enabled plugin(s)"
                : "Select a profile to begin";
            return;
        }

        if (state.activeTab === "plugins") {
            topbarMetaEl.textContent = state.plugins.length + " installed plugin(s)";
            return;
        }

        topbarMetaEl.textContent = "Market placeholder";
    }

    function renderProfilesTab() {
        if (state.loading.boot) {
            return renderPlaceholder("正在加载配置中心", "正在读取 profiles 和 plugins...");
        }

        if (!state.profiles.length) {
            return renderEmpty("还没有 profile", "请先在 profiles 目录下准备 .toml 文件，然后刷新页面。");
        }

        var draft = state.selectedProfileDraft;
        if (state.loading.profile || !draft) {
            return renderPlaceholder("正在加载 profile", "请稍候，正在读取所选 profile 的内容。");
        }

        var rawProfile = state.selectedProfileRaw || {};
        var profileMeta = isPlainObject(rawProfile.profile) ? rawProfile.profile : {};
        if (draft.enabled.length && draft.enabled.indexOf(state.ui.activePluginId) === -1) {
            state.ui.activePluginId = draft.enabled[0];
        }
        var availablePlugins = state.plugins.filter(function (plugin) {
            return draft.enabled.indexOf(plugin.id) === -1;
        });
        var saveDisabled = state.loading.save || state.loading.reload;
        var layoutClass = "grid profiles-layout" + (state.ui.profileSidebarCollapsed ? " is-profile-collapsed" : "");

        return [
            '<div class="' + layoutClass + '">',
            (state.ui.profileSidebarCollapsed ? "" : renderProfileSidebar(profileMeta, draft, availablePlugins)),
            '  <section class="card"><div class="card-body">',
            '    <div class="section-title">',
            "      <div>",
            "        <h3>Enabled Plugins</h3>",
            '        <p class="muted">按 `config_schema` 渲染基础表单；缺少 schema 时退化为原始 JSON 编辑。</p>',
            "      </div>",
            '      <div class="section-actions">',
            '        <button class="button" type="button" data-action="expand-all-plugins">全部展开</button>',
            '        <button class="button" type="button" data-action="collapse-all-plugins">全部折叠</button>',
            "      </div>",
            "    </div>",
            renderEnabledPlugins(draft.enabled, draft),
            "  </div>",
            '  <div class="sticky-actions">',
            '    <div class="row">',
            '      <button class="button" type="button" data-action="save-profile" ' + (saveDisabled ? "disabled" : "") + ">" + (state.loading.save && !state.loading.reload ? "保存中..." : "保存") + "</button>",
            '      <button class="button is-primary" type="button" data-action="save-reload" ' + (saveDisabled ? "disabled" : "") + ">" + (state.loading.reload ? "保存并重载中..." : "保存并重载") + "</button>",
            '    </div>',
            '    <p class="note">保存只写回当前 profile；保存并重载会在保存成功后调用 `/admin/api/agent/reload`。</p>',
            "  </div>",
            "  </section>",
            "</div>"
        ].join("");
    }

    function renderProfileSidebar(profileMeta, draft, availablePlugins) {
        return [
            '  <section class="card"><div class="card-body stack">',
            '    <div class="section-title">',
            "      <div>",
            "        <h3>Profile</h3>",
            '        <p class="muted">选择 profile，并把插件配置映射回真实的 TOML 结构。</p>',
            "      </div>",
            "    </div>",
            '    <div class="toolbar">',
            '      <div>',
            '        <label class="label" for="profileSelect">Current profile</label>',
            '        <select id="profileSelect" class="select">',
            renderProfileOptions(state.profiles, state.selectedProfileName),
            "        </select>",
            "      </div>",
            '      <div class="meta-grid">',
            renderMetaItem("profile.name", displayValue(profileMeta.name)),
            renderMetaItem("agent_name", displayValue(profileMeta.agent_name)),
            renderMetaItem("description", displayValue(profileMeta.description || "—")),
            renderMetaItem("enabled", String(draft.enabled.length)),
            "      </div>",
            '      <div class="divider"></div>',
            '      <div class="stack">',
            '        <div class="row">',
            '          <div class="grow">',
            '            <label class="label" for="addPluginSelect">从已安装插件添加</label>',
            '            <select id="addPluginSelect" class="select" ' + (availablePlugins.length ? "" : "disabled") + ">",
            renderPluginAddOptions(availablePlugins),
            "            </select>",
            "          </div>",
            '          <button class="button" type="button" data-action="add-plugin" ' + (availablePlugins.length ? "" : "disabled") + ">添加</button>",
            "        </div>",
            '        <p class="note">只列出已安装但当前 profile 尚未启用的插件。</p>',
            "      </div>",
            "    </div>",
            "  </div></section>"
        ].join("");
    }

    function renderEnabledPlugins(enabled, draft) {
        if (!enabled.length) {
            return renderEmpty("当前没有已启用插件", "可以通过左侧下拉框从已安装插件中添加。");
        }

        return [
            '<div class="plugin-workspace">',
            renderPluginOutline(enabled),
            '  <div class="plugin-panels">',
            enabled.map(function (pluginId) {
                return renderPluginEditor(pluginId, draft);
            }).join(""),
            "  </div>",
            "</div>"
        ].join("");
    }

    function renderPluginOutline(enabled) {
        return [
            '  <aside class="plugin-outline">',
            '    <div class="plugin-outline-header">',
            "      <h4>Plugin Nav</h4>",
            '      <p class="muted">快速定位到对应插件卡片。</p>',
            "    </div>",
            '    <div class="plugin-outline-list">',
            enabled.map(function (pluginId) {
                return renderPluginOutlineLink(pluginId);
            }).join(""),
            "    </div>",
            "  </aside>"
        ].join("");
    }

    function renderPluginOutlineLink(pluginId) {
        var pluginDef = state.pluginMap[pluginId] || createUnknownPluginDefinition(pluginId);
        var meta = isPlainObject(pluginDef.plugin) ? pluginDef.plugin : {};
        var isActive = state.ui.activePluginId === pluginId;
        return (
            '<button class="plugin-outline-link' +
            (isActive ? " is-active" : "") +
            '" type="button" data-action="jump-plugin" data-plugin-id="' +
            escapeAttribute(pluginId) +
            '">' +
            escapeHtml(meta.name || pluginId) +
            "</button>"
        );
    }

    function renderPluginEditor(pluginId, draft) {
        var pluginDef = state.pluginMap[pluginId] || createUnknownPluginDefinition(pluginId);
        var meta = isPlainObject(pluginDef.plugin) ? pluginDef.plugin : {};
        var schema = isPlainObject(pluginDef.config_schema) ? pluginDef.config_schema : {};
        var schemaKeys = Object.keys(schema);
        var body = "";
        var isCollapsed = Boolean(state.ui.collapsedPlugins[pluginId]);

        if (schemaKeys.length === 0) {
            body = renderRawPluginEditor(pluginId, pluginDef, draft);
        } else {
            body = [
                '<div class="fields">',
                schemaKeys.map(function (field) {
                    return renderSchemaField(pluginId, field, pluginDef, draft);
                }).join(""),
                "</div>",
                renderExtraOverrideSummary(pluginId, draft.extraOverrides[pluginId])
            ].join("");
        }

        return [
            '<article id="' + escapeAttribute(pluginCardDomId(pluginId)) + '" class="plugin-card card' + (isCollapsed ? " is-collapsed" : "") + '"><div class="card-body">',
            '  <div class="plugin-head">',
            "    <div>",
            "      <h4>" + escapeHtml(meta.name || pluginId) + "</h4>",
            '      <p class="muted">' + escapeHtml(meta.description || "No description") + "</p>",
            "    </div>",
            '    <div class="badges">',
            '      <span class="badge">' + escapeHtml(pluginId) + "</span>",
            '      <span class="badge is-muted">' + escapeHtml(meta.type || "unknown") + "</span>",
            (state.pluginMap[pluginId] ? "" : '<span class="badge is-warning">metadata missing</span>'),
            '      <button class="button is-subtle icon-button chevron-button' + (isCollapsed ? " is-collapsed" : "") + '" type="button" data-action="toggle-plugin" data-plugin-id="' + escapeAttribute(pluginId) + '" aria-expanded="' + String(!isCollapsed) + '" title="' + (isCollapsed ? "展开插件卡片" : "折叠插件卡片") + '"><span class="sr-only">' + (isCollapsed ? "展开插件卡片" : "折叠插件卡片") + "</span></button>",
            '      <button class="button is-subtle is-danger" type="button" data-action="remove-plugin" data-plugin-id="' + escapeAttribute(pluginId) + '">移除</button>',
            "    </div>",
            "  </div>",
            '  <div class="plugin-content">' + body + "</div>",
            "</div></article>"
        ].join("");
    }

    function renderSchemaField(pluginId, field, pluginDef, draft) {
        var schemaField = pluginDef.config_schema[field] || {};
        var currentValue = draft.values[pluginId] ? draft.values[pluginId][field] : "";
        var defaultValue = getDefaultFieldValue(pluginDef, field);
        var usingDefault = deepEqual(normalizeNumberForCompare(currentValue, schemaField), defaultValue);
        var badges = [
            '<span class="badge ' + (usingDefault ? "is-muted" : "is-success") + '">' + (usingDefault ? "default" : "override") + "</span>"
        ];

        if (schemaField.type) {
            badges.push('<span class="badge is-muted">' + escapeHtml(schemaField.type) + "</span>");
        }

        return [
            '<section class="field">',
            '  <div class="field-top">',
            "    <div>",
            '      <div class="field-title">' + escapeHtml(field) + "</div>",
            "    </div>",
            '    <div class="badges">' + badges.join("") + "</div>",
            "  </div>",
            '  <p class="field-desc">' + escapeHtml(schemaField.description || "No description") + "</p>",
            renderSchemaInput(pluginId, field, schemaField, currentValue),
            '  <div class="field-meta">默认值: ' + escapeHtml(displayValue(defaultValue)) + extraNumberMeta(schemaField) + "</div>",
            "</section>"
        ].join("");
    }

    function renderSchemaInput(pluginId, field, schemaField, currentValue) {
        var common = ' data-plugin-id="' + escapeAttribute(pluginId) + '" data-field="' + escapeAttribute(field) + '"';

        if (schemaField.type === "bool") {
            return [
                '<div class="field-input-row">',
                '  <label class="toggle">',
                '    <input type="checkbox" data-field-type="bool"' + common + (Boolean(currentValue) ? " checked" : "") + ">",
                '    <span>' + (Boolean(currentValue) ? "Enabled" : "Disabled") + "</span>",
                "  </label>",
                '  <button class="button" type="button" data-action="reset-field" data-plugin-id="' + escapeAttribute(pluginId) + '" data-field="' + escapeAttribute(field) + '">恢复默认</button>',
                "</div>"
            ].join("");
        }

        var inputType = schemaField.type === "int" || schemaField.type === "float" ? "number" : "text";
        var step = schemaField.type === "int" ? "1" : (schemaField.type === "float" ? "any" : "");
        var min = typeof schemaField.min !== "undefined" ? ' min="' + escapeAttribute(String(schemaField.min)) + '"' : "";
        var max = typeof schemaField.max !== "undefined" ? ' max="' + escapeAttribute(String(schemaField.max)) + '"' : "";
        var stepAttr = step ? ' step="' + step + '"' : "";

        return [
            '<div class="field-input-row">',
            '  <input class="input" type="' + inputType + '" data-field-type="' + escapeAttribute(schemaField.type || "str") + '"' + common + stepAttr + min + max + ' value="' + escapeAttribute(displayInputValue(currentValue)) + '">',
            '  <button class="button" type="button" data-action="reset-field" data-plugin-id="' + escapeAttribute(pluginId) + '" data-field="' + escapeAttribute(field) + '">恢复默认</button>',
            "</div>"
        ].join("");
    }

    function renderRawPluginEditor(pluginId, pluginDef, draft) {
        var value = draft.values[pluginId];
        var defaults = isPlainObject(pluginDef.config) ? pluginDef.config : {};
        var hasConfig = value && Object.keys(value).length > 0;
        var hasDefaults = defaults && Object.keys(defaults).length > 0;

        if (!hasConfig && !hasDefaults) {
            return '<div class="empty-copy">该插件没有 `config_schema`，当前也没有可编辑的 override 配置。</div>';
        }

        return [
            '<div class="stack">',
            '  <p class="field-desc">该插件未提供 `config_schema`，已退化为原始 JSON 编辑。保存时会直接写回 `[plugins.' + escapeHtml(pluginId) + ']`。</p>',
            hasDefaults ? ('<div><p class="small-title">Default Config</p><pre class="pre">' + escapeHtml(safeJsonStringify(defaults)) + "</pre></div>") : "",
            '  <div>',
            '    <p class="small-title">Current Override</p>',
            '    <textarea class="textarea" data-raw-plugin="' + escapeAttribute(pluginId) + '">' + escapeHtml(safeJsonStringify(value || {})) + "</textarea>",
            "  </div>",
            "</div>"
        ].join("");
    }

    function renderExtraOverrideSummary(pluginId, extras) {
        if (!isPlainObject(extras) || !Object.keys(extras).length) {
            return "";
        }

        return [
            '<div class="stack">',
            '  <p class="small-title">Additional preserved overrides</p>',
            '  <pre class="pre">' + escapeHtml(safeJsonStringify(extras)) + "</pre>",
            '  <p class="note">这些字段不在 `config_schema` 中，页面会在保存时原样保留。</p>',
            "</div>"
        ].join("");
    }

    function renderPluginsTab() {
        if (state.loading.boot) {
            return renderPlaceholder("正在读取插件信息", "等待 `/admin/api/plugins` 返回结果...");
        }

        if (!state.plugins.length) {
            return renderEmpty("没有已安装插件", "当前 `/admin/api/plugins` 返回为空。");
        }

        return [
            '<div class="plugins-grid">',
            state.plugins.map(function (plugin) {
                return renderPluginInfoCard(plugin);
            }).join(""),
            "</div>"
        ].join("");
    }

    function renderPluginInfoCard(plugin) {
        var meta = isPlainObject(plugin.plugin) ? plugin.plugin : {};
        var isEnabled = Boolean(state.selectedProfileDraft && state.selectedProfileDraft.enabled.indexOf(plugin.id) >= 0);

        return [
            '<article class="card plugin-info-card"><div class="card-body">',
            '  <div class="plugin-head">',
            "    <div>",
            "      <h3>" + escapeHtml(meta.name || plugin.id) + "</h3>",
            '      <p class="muted">' + escapeHtml(meta.description || "No description") + "</p>",
            "    </div>",
            '    <div class="badges">',
            '      <span class="badge">' + escapeHtml(plugin.id) + "</span>",
            '      <span class="badge is-muted">' + escapeHtml(meta.type || "unknown") + "</span>",
            (isEnabled ? '<span class="badge is-success">enabled in current profile</span>' : ""),
            "    </div>",
            "  </div>",
            '  <div class="meta-grid">',
            renderMetaItem("path", displayValue(plugin.path || "—")),
            renderMetaItem("version", displayValue(meta.version || "—")),
            renderMetaItem("source", displayValue(meta.source || "—")),
            renderMetaItem("author", displayValue(meta.author || "—")),
            "  </div>",
            '  <div class="split-pre">',
            '    <div><p class="small-title">Default Config</p><pre class="pre">' + escapeHtml(safeJsonStringify(plugin.config || {})) + "</pre></div>",
            '    <div><p class="small-title">Config Schema</p><pre class="pre">' + escapeHtml(safeJsonStringify(plugin.config_schema || {})) + "</pre></div>",
            "  </div>",
            "</div></article>"
        ].join("");
    }

    function renderMarketTab() {
        return [
            '<section class="card placeholder"><div class="card-body">',
            "  <h3>Market</h3>",
            '  <p class="empty-copy">即将上线</p>',
            '  <p class="note">本阶段不接远端 registry，不调用额外 API。</p>',
            "</div></section>"
        ].join("");
    }

    function loadBooleanPreference(key, fallback) {
        try {
            var value = window.localStorage.getItem(key);
            if (value === null) {
                return fallback;
            }
            return value === "true";
        } catch (error) {
            return fallback;
        }
    }

    function loadThemePreference() {
        try {
            return window.localStorage.getItem(THEME_STORAGE_KEY) || "day";
        } catch (error) {
            return "day";
        }
    }

    function applyTheme(theme) {
        var nextTheme = theme === "day" ? "day" : "night";
        document.body.setAttribute("data-theme", nextTheme);

        if (themeToggleEl) {
            var isNight = nextTheme === "night";
            themeToggleEl.textContent = isNight ? "切换到白天模式" : "切换到夜间模式";
            themeToggleEl.setAttribute("aria-pressed", String(isNight));
        }
    }

    function toggleTheme() {
        var currentTheme = document.body.getAttribute("data-theme") || "night";
        var nextTheme = currentTheme === "night" ? "day" : "night";
        applyTheme(nextTheme);

        try {
            window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
        } catch (error) {
            return;
        }
    }

    function applyLayoutState() {
        if (appShellEl) {
            appShellEl.classList.toggle("is-admin-collapsed", state.ui.adminSidebarCollapsed);
        }
    }

    function toggleAdminSidebar() {
        state.ui.adminSidebarCollapsed = !state.ui.adminSidebarCollapsed;
        applyLayoutState();
        renderTopbar();

        try {
            window.localStorage.setItem(ADMIN_SIDEBAR_STORAGE_KEY, String(state.ui.adminSidebarCollapsed));
        } catch (error) {
            return;
        }
    }

    function toggleProfileSidebar() {
        if (state.activeTab !== "profiles") {
            return;
        }
        state.ui.profileSidebarCollapsed = !state.ui.profileSidebarCollapsed;
        render();

        try {
            window.localStorage.setItem(PROFILE_SIDEBAR_STORAGE_KEY, String(state.ui.profileSidebarCollapsed));
        } catch (error) {
            return;
        }
    }

    function renderProfileOptions(profiles, selected) {
        return profiles.map(function (name) {
            return '<option value="' + escapeAttribute(name) + '"' + (name === selected ? " selected" : "") + ">" + escapeHtml(name) + "</option>";
        }).join("");
    }

    function renderPluginAddOptions(plugins) {
        if (!plugins.length) {
            return '<option value="">No more installed plugins</option>';
        }

        return plugins.map(function (plugin, index) {
            var label = plugin.plugin && plugin.plugin.name ? plugin.plugin.name + " (" + plugin.id + ")" : plugin.id;
            return '<option value="' + escapeAttribute(plugin.id) + '"' + (index === 0 ? " selected" : "") + ">" + escapeHtml(label) + "</option>";
        }).join("");
    }

    function renderMetaItem(label, value) {
        return [
            '<div class="meta-item">',
            '  <div class="meta-label">' + escapeHtml(label) + "</div>",
            '  <div class="meta-value">' + escapeHtml(value) + "</div>",
            "</div>"
        ].join("");
    }

    function renderEmpty(title, copy) {
        return [
            '<section class="card empty"><div class="card-body">',
            "  <h3>" + escapeHtml(title) + "</h3>",
            '  <p class="empty-copy">' + escapeHtml(copy) + "</p>",
            "</div></section>"
        ].join("");
    }

    function renderPlaceholder(title, copy) {
        return [
            '<section class="card placeholder"><div class="card-body">',
            "  <h3>" + escapeHtml(title) + "</h3>",
            '  <p class="empty-copy">' + escapeHtml(copy) + "</p>",
            "</div></section>"
        ].join("");
    }

    function setMessage(text, type) {
        messageEl.textContent = text;
        messageEl.className = "message is-" + (type || "info");
    }

    function clearMessage() {
        messageEl.textContent = "";
        messageEl.className = "message is-hidden";
    }

    function getErrorMessage(error, fallback) {
        if (!error) {
            return fallback;
        }
        return error.message ? fallback + ": " + error.message : fallback;
    }

    function displayValue(value) {
        if (typeof value === "string" && value !== "") {
            return value;
        }
        if (typeof value === "undefined" || value === null || value === "") {
            return "—";
        }
        if (typeof value === "object") {
            return safeJsonStringify(value);
        }
        return String(value);
    }

    function displayInputValue(value) {
        if (typeof value === "undefined" || value === null) {
            return "";
        }
        return String(value);
    }

    function extraNumberMeta(schemaField) {
        var details = [];
        if (typeof schemaField.min !== "undefined") {
            details.push("min " + schemaField.min);
        }
        if (typeof schemaField.max !== "undefined") {
            details.push("max " + schemaField.max);
        }
        return details.length ? " · " + details.join(" / ") : "";
    }

    function capitalize(value) {
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    function pluginCardDomId(pluginId) {
        return "plugin-card-" + String(pluginId).replace(/[^a-zA-Z0-9_-]/g, "-");
    }

    function mergeObjects(base, override) {
        var merged = isPlainObject(base) ? deepClone(base) : {};
        if (!isPlainObject(override)) {
            return merged;
        }
        Object.keys(override).forEach(function (key) {
            merged[key] = deepClone(override[key]);
        });
        return merged;
    }

    function deepClone(value) {
        if (typeof value === "undefined") {
            return undefined;
        }
        return JSON.parse(JSON.stringify(value));
    }

    function deepEqual(a, b) {
        if (a === b) {
            return true;
        }

        if (typeof a !== typeof b) {
            return false;
        }

        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) {
                return false;
            }
            for (var i = 0; i < a.length; i += 1) {
                if (!deepEqual(a[i], b[i])) {
                    return false;
                }
            }
            return true;
        }

        if (isPlainObject(a) && isPlainObject(b)) {
            var aKeys = Object.keys(a);
            var bKeys = Object.keys(b);
            if (aKeys.length !== bKeys.length) {
                return false;
            }
            for (var j = 0; j < aKeys.length; j += 1) {
                var key = aKeys[j];
                if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) {
                    return false;
                }
            }
            return true;
        }

        return false;
    }

    function safeJsonStringify(value) {
        return JSON.stringify(typeof value === "undefined" ? {} : value, null, 2);
    }

    function isPlainObject(value) {
        return Object.prototype.toString.call(value) === "[object Object]";
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function escapeAttribute(value) {
        return escapeHtml(value).replace(/`/g, "&#96;");
    }

    if (adminSidebarToggleEl) {
        adminSidebarToggleEl.addEventListener("click", toggleAdminSidebar);
    }

    if (profileSidebarToggleEl) {
        profileSidebarToggleEl.addEventListener("click", toggleProfileSidebar);
    }

    if (themeToggleEl) {
        themeToggleEl.addEventListener("click", toggleTheme);
    }
})();
