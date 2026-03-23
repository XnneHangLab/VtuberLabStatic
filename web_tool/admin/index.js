(function () {
    "use strict";

    var API_BASE = window.location.origin + "/admin/api";
    var state = {
        activeTab: "profiles",
        plugins: [],
        profiles: [],
        providers: [],
        pluginMap: {},
        selectedProfileName: "",
        selectedProfileRaw: null,
        selectedProfileDraft: null,
        agentConfigDraft: null,
        providerDrafts: {},
        newProviderDraft: {
            name: "",
            base_url: "",
            api_key: "",
            api_format: "chat_completion"
        },
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
            reload: false,
            providers: false,
            providerSave: false,
            agentConfigSave: false
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

    document.addEventListener("click", handleClick);
    document.addEventListener("change", handleChange);
    document.addEventListener("input", handleInput);

    syncTabFromHash();
    window.addEventListener("hashchange", handleHashChange);
    render();
    initialize();
    async function initialize() {
        state.loading.boot = true;
        setMessage("正在加载 Profiles 和 Plugins...", "info");
        render();

        var results = await Promise.allSettled([fetchPlugins(), fetchProfiles(), fetchProviders(), fetchAgentConfig()]);
        var pluginsResult = results[0];
        var profilesResult = results[1];
        var providersResult = results[2];
        var agentConfigResult = results[3];

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

        if (providersResult.status === "fulfilled") {
            state.providers = providersResult.value;
            state.providerDrafts = buildProviderDrafts(state.providers);
        } else {
            setMessage(getErrorMessage(providersResult.reason, "加载 provider 列表失败"), "error");
        }

        if (agentConfigResult.status === "fulfilled") {
            state.agentConfigDraft = deepClone(agentConfigResult.value);
        } else {
            setMessage(getErrorMessage(agentConfigResult.reason, "加载 agent 配置失败"), "error");
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

    async function fetchProviders() {
        return apiFetch("/providers");
    }

    async function fetchAgentConfig() {
        return apiFetch("/config/agent");
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

    function buildProviderDrafts(providers) {
        var drafts = {};
        providers.forEach(function (provider) {
            drafts[provider.name] = {
                name: provider.name,
                base_url: typeof provider.base_url === "string" ? provider.base_url : "",
                api_key: "",
                api_format: typeof provider.api_format === "string" ? provider.api_format : "chat_completion",
                api_key_masked: typeof provider.api_key_masked === "string" ? provider.api_key_masked : "",
                has_api_key: Boolean(provider.has_api_key)
            };
        });
        return drafts;
    }

    async function refreshProviderState() {
        state.loading.providers = true;
        render();

        try {
            var results = await Promise.all([fetchProviders(), fetchAgentConfig()]);
            state.providers = results[0];
            state.providerDrafts = buildProviderDrafts(state.providers);
            state.agentConfigDraft = deepClone(results[1]);
        } finally {
            state.loading.providers = false;
            render();
        }
    }

    function updateProviderDraftField(providerName, field, value) {
        if (!providerName || !state.providerDrafts[providerName]) {
            return;
        }
        state.providerDrafts[providerName][field] = value;
    }

    function updateAgentModelField(modelKind, field, value) {
        if (!state.agentConfigDraft || !modelKind || !state.agentConfigDraft[modelKind]) {
            return;
        }
        state.agentConfigDraft[modelKind][field] = value;
    }

    async function createProvider() {
        if (state.loading.providerSave) {
            return;
        }

        var name = String(state.newProviderDraft.name || "").trim();
        if (!name) {
            setMessage("请输入 provider name。", "warning");
            return;
        }

        state.loading.providerSave = true;
        setMessage("正在创建 provider...", "info");
        render();

        try {
            await apiFetch("/providers", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    name: name,
                    base_url: state.newProviderDraft.base_url,
                    api_key: state.newProviderDraft.api_key,
                    api_format: state.newProviderDraft.api_format
                })
            });
            state.newProviderDraft = {
                name: "",
                base_url: "",
                api_key: "",
                api_format: "chat_completion"
            };
            await refreshProviderState();
            await reloadAgentAfterConfigChange("Provider 已创建，agent 已重载。");
        } catch (error) {
            setMessage(getErrorMessage(error, "创建 provider 失败"), "error");
        } finally {
            state.loading.providerSave = false;
            render();
        }
    }

    async function saveProvider(providerName) {
        if (state.loading.providerSave || !providerName || !state.providerDrafts[providerName]) {
            return;
        }

        var draft = state.providerDrafts[providerName];
        var payload = {
            base_url: draft.base_url,
            api_format: draft.api_format
        };
        if (draft.api_key !== "") {
            payload.api_key = draft.api_key;
        }

        state.loading.providerSave = true;
        setMessage("正在保存 provider: " + providerName, "info");
        render();

        try {
            await apiFetch("/providers/" + encodeURIComponent(providerName), {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });
            await refreshProviderState();
            await reloadAgentAfterConfigChange("Provider 已更新，agent 已重载。");
        } catch (error) {
            setMessage(getErrorMessage(error, "更新 provider 失败"), "error");
        } finally {
            state.loading.providerSave = false;
            render();
        }
    }

    async function deleteProvider(providerName) {
        if (state.loading.providerSave || !providerName) {
            return;
        }

        state.loading.providerSave = true;
        setMessage("正在删除 provider: " + providerName, "info");
        render();

        try {
            await apiFetch("/providers/" + encodeURIComponent(providerName), {
                method: "DELETE"
            });
            await refreshProviderState();
            await reloadAgentAfterConfigChange("Provider 已删除，agent 已重载。");
        } catch (error) {
            setMessage(getErrorMessage(error, "删除 provider 失败"), "error");
        } finally {
            state.loading.providerSave = false;
            render();
        }
    }

    async function saveAgentConfig() {
        if (state.loading.agentConfigSave || !state.agentConfigDraft) {
            return;
        }

        state.loading.agentConfigSave = true;
        setMessage("正在保存 agent 模型配置...", "info");
        render();

        try {
            await apiFetch("/config/agent", {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    chat_model: {
                        llm_provider: state.agentConfigDraft.chat_model.llm_provider,
                        llm_model_name: state.agentConfigDraft.chat_model.llm_model_name
                    },
                    vision_model: {
                        llm_provider: state.agentConfigDraft.vision_model.llm_provider,
                        llm_model_name: state.agentConfigDraft.vision_model.llm_model_name
                    }
                })
            });
            await refreshProviderState();
            await reloadAgentAfterConfigChange("Agent 模型配置已保存，agent 已重载。");
        } catch (error) {
            setMessage(getErrorMessage(error, "保存 agent 模型配置失败"), "error");
        } finally {
            state.loading.agentConfigSave = false;
            render();
        }
    }

    async function reloadAgentAfterConfigChange(successMessage) {
        try {
            await apiFetch("/agent/reload", {
                method: "POST"
            });
            setMessage(successMessage, "success");
        } catch (reloadError) {
            setMessage("配置已保存，但 agent 重载失败: " + getErrorMessage(reloadError, "reload failed"), "warning");
        }
    }

    function pickDefaultProfile(profiles) {
        return profiles.indexOf("baoqiao.toml") >= 0 ? "baoqiao.toml" : profiles[0];
    }

    function createProfileDraft(rawProfile, pluginMap) {
        var pluginsSection = isPlainObject(rawProfile && rawProfile.plugins) ? rawProfile.plugins : {};
        var characterSection = isPlainObject(rawProfile && rawProfile.character) ? rawProfile.character : {};
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
            explicitFields: explicitFields,
            character: normalizeCharacterDraft(characterSection)
        };
    }

    function boolVal(obj, key, defaultVal) {
        if (!isPlainObject(obj)) {
            return defaultVal;
        }
        return Object.prototype.hasOwnProperty.call(obj, key) ? Boolean(obj[key]) : defaultVal;
    }

    function normalizeEmotionDraft(value) {
        if (isPlainObject(value)) {
            return {
                path: typeof value.path === "string" ? value.path : "",
                ref_text: typeof value.ref_text === "string" ? value.ref_text : ""
            };
        }
        if (typeof value === "string") {
            return {
                path: value,
                ref_text: ""
            };
        }
        return {
            path: "",
            ref_text: ""
        };
    }

    function normalizeCharacterTtsDraft(ttsDraft) {
        var nextDraft = isPlainObject(ttsDraft) ? deepClone(ttsDraft) : {};
        if (!isPlainObject(nextDraft.emotions)) {
            nextDraft.emotions = { "default": { path: "emotions/neutral.wav", ref_text: "" } };
        } else {
            Object.keys(nextDraft.emotions).forEach(function (key) {
                nextDraft.emotions[key] = normalizeEmotionDraft(nextDraft.emotions[key]);
            });
        }
        if (typeof nextDraft.character_name !== "string") {
            nextDraft.character_name = "";
        }
        return nextDraft;
    }

    function normalizeCharacterDraft(characterSection) {
        var nextCharacter = isPlainObject(characterSection) ? deepClone(characterSection) : {};
        var preprocessor = isPlainObject(nextCharacter.tts_preprocessor) ? nextCharacter.tts_preprocessor : {};

        return {
            conf_name: nextCharacter.conf_name || "",
            conf_uid: nextCharacter.conf_uid || "",
            live2d_model_name: nextCharacter.live2d_model_name || "",
            character_name: nextCharacter.character_name || "",
            avatar: nextCharacter.avatar || "",
            human_name: nextCharacter.human_name || "",
            tts_preprocessor: {
                remove_special_char: boolVal(preprocessor, "remove_special_char", true),
                ignore_brackets: boolVal(preprocessor, "ignore_brackets", true),
                ignore_parentheses: boolVal(preprocessor, "ignore_parentheses", true),
                ignore_asterisks: boolVal(preprocessor, "ignore_asterisks", true),
                ignore_angle_brackets: boolVal(preprocessor, "ignore_angle_brackets", true)
            },
            tts: normalizeCharacterTtsDraft(nextCharacter.tts)
        };
    }

    function ensureCharacterDraft(draft) {
        if (!draft) {
            return normalizeCharacterDraft({});
        }
        draft.character = normalizeCharacterDraft(draft.character);
        return draft.character;
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
        if (type === "list") {
            return [];
        }
        if (type === "object") {
            var properties = isPlainObject(fieldSchema.properties) ? fieldSchema.properties : {};
            var nextObject = {};
            Object.keys(properties).forEach(function (key) {
                nextObject[key] = emptyValueForSchemaField(properties[key]);
            });
            return nextObject;
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
                    var normalizedCurrent = normalizeSchemaValueForSave(currentValue, schema[field]);
                    var normalizedDefault = normalizeSchemaValueForCompare(defaultValue, schema[field]);
                    var keepExplicit =
                        Boolean(draft.explicitFields[pluginId]) &&
                        Boolean(draft.explicitFields[pluginId][field]);

                    if (normalizedCurrent === "" && schema[field] && (schema[field].type === "int" || schema[field].type === "float")) {
                        return;
                    }

                    if (keepExplicit || !deepEqual(normalizedCurrent, normalizedDefault)) {
                        serialized[field] = normalizedCurrent;
                    }
                });
            }

            if (isPlainObject(serialized) && Object.keys(serialized).length > 0) {
                nextPlugins[pluginId] = serialized;
            }
        });

        payload.plugins = nextPlugins;
        payload.character = isPlainObject(payload.character) ? payload.character : {};
        payload.character.conf_name = ensureCharacterDraft(draft).conf_name;
        payload.character.conf_uid = ensureCharacterDraft(draft).conf_uid;
        payload.character.live2d_model_name = ensureCharacterDraft(draft).live2d_model_name;
        payload.character.character_name = ensureCharacterDraft(draft).character_name;
        payload.character.avatar = ensureCharacterDraft(draft).avatar;
        payload.character.human_name = ensureCharacterDraft(draft).human_name;
        payload.character.tts_preprocessor = deepClone(ensureCharacterDraft(draft).tts_preprocessor);
        payload.character.tts = deepClone(ensureCharacterDraft(draft).tts);
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

    function normalizeSchemaValueForCompare(value, schemaField) {
        return normalizeSchemaValueForSave(value, schemaField);
    }

    function normalizeSchemaValueForSave(value, schemaField) {
        if (!schemaField || !schemaField.type) {
            return value;
        }

        if (schemaField.type === "list") {
            var items = Array.isArray(value) ? value : [];
            return items.map(function (item) {
                return normalizeSchemaValueForSave(item, schemaField.items || {});
            });
        }

        if (schemaField.type === "object") {
            var properties = isPlainObject(schemaField.properties) ? schemaField.properties : {};
            var source = isPlainObject(value) ? value : {};
            var nextObject = {};
            Object.keys(properties).forEach(function (key) {
                nextObject[key] = normalizeSchemaValueForSave(source[key], properties[key]);
            });
            return nextObject;
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
            updateLocationHash();
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
        if (action === "add-tts-emotion") {
            addTtsEmotion();
            return;
        }
        if (action === "remove-emotion") {
            removeTtsEmotion(actionEl.getAttribute("data-key"));
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
            return;
        }
        if (action === "add-list-item") {
            addListItem(
                actionEl.getAttribute("data-plugin-id"),
                actionEl.getAttribute("data-field"),
                parseFieldPath(actionEl.getAttribute("data-field-path"))
            );
            return;
        }
        if (action === "remove-list-item") {
            removeListItem(
                actionEl.getAttribute("data-plugin-id"),
                actionEl.getAttribute("data-field"),
                parseFieldPath(actionEl.getAttribute("data-field-path"))
            );
            return;
        }
        if (action === "create-provider") {
            createProvider();
            return;
        }
        if (action === "save-provider") {
            saveProvider(actionEl.getAttribute("data-provider-name"));
            return;
        }
        if (action === "delete-provider") {
            deleteProvider(actionEl.getAttribute("data-provider-name"));
            return;
        }
        if (action === "save-agent-config") {
            saveAgentConfig();
        }
    }

    function handleChange(event) {
        var target = event.target;

        if (target.id === "profileSelect") {
            loadProfile(target.value, false);
            return;
        }

        if (target.matches("[data-action='update-agent-provider']")) {
            updateAgentModelField(target.getAttribute("data-model-kind"), "llm_provider", target.value);
            return;
        }

        if (target.matches("[data-field-type='bool']")) {
            updateSchemaValue(
                target.getAttribute("data-plugin-id"),
                target.getAttribute("data-field"),
                target.checked,
                parseFieldPath(target.getAttribute("data-field-path"))
            );
            var textEl = target.parentElement ? target.parentElement.querySelector("span") : null;
            if (textEl) {
                textEl.textContent = target.checked ? "Enabled" : "Disabled";
            }
            return;
        }

        if (target.matches("[data-action='update-tts-character-name']")) {
            updateTtsCharacterName(target.value);
            return;
        }

        if (target.matches("[data-action='update-character-field']")) {
            updateCharacterField(target.getAttribute("data-field"), target.value);
            return;
        }

        if (target.matches("[data-action='update-tts-preprocessor']")) {
            updateTtsPreprocessorField(target.getAttribute("data-field"), target.checked);
            return;
        }

        if (target.matches("[data-action='update-emotion-key']")) {
            renameTtsEmotionKey(target.getAttribute("data-old-key"), target.value);
            return;
        }

        if (target.matches("[data-action='update-emotion-path']")) {
            updateTtsEmotionPath(target.getAttribute("data-key"), target.value);
            return;
        }

        if (target.matches("[data-action='update-emotion-ref-text']")) {
            updateTtsEmotionRefText(target.getAttribute("data-key"), target.value);
            return;
        }

        if (target.matches("[data-raw-plugin]")) {
            updateRawPluginConfig(target);
        }
    }

    function handleInput(event) {
        var target = event.target;
        if (target.matches("[data-action='update-new-provider-name']")) {
            state.newProviderDraft.name = target.value;
            return;
        }

        if (target.matches("[data-action='update-new-provider-base-url']")) {
            state.newProviderDraft.base_url = target.value;
            return;
        }

        if (target.matches("[data-action='update-new-provider-api-key']")) {
            state.newProviderDraft.api_key = target.value;
            return;
        }

        if (target.matches("[data-action='update-new-provider-api-format']")) {
            state.newProviderDraft.api_format = target.value;
            return;
        }

        if (target.matches("[data-action='update-provider-base-url']")) {
            updateProviderDraftField(target.getAttribute("data-provider-name"), "base_url", target.value);
            return;
        }

        if (target.matches("[data-action='update-provider-api-key']")) {
            updateProviderDraftField(target.getAttribute("data-provider-name"), "api_key", target.value);
            return;
        }

        if (target.matches("[data-action='update-provider-api-format']")) {
            updateProviderDraftField(target.getAttribute("data-provider-name"), "api_format", target.value);
            return;
        }

        if (target.matches("[data-action='update-agent-model-name']")) {
            updateAgentModelField(target.getAttribute("data-model-kind"), "llm_model_name", target.value);
            return;
        }

        if (target.matches("[data-field-type='str']")) {
            updateSchemaValue(
                target.getAttribute("data-plugin-id"),
                target.getAttribute("data-field"),
                target.value,
                parseFieldPath(target.getAttribute("data-field-path"))
            );
            return;
        }

        if (target.matches("[data-field-type='int'], [data-field-type='float']")) {
            updateSchemaValue(
                target.getAttribute("data-plugin-id"),
                target.getAttribute("data-field"),
                target.value,
                parseFieldPath(target.getAttribute("data-field-path"))
            );
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

    function parseFieldPath(rawPath) {
        if (!rawPath) {
            return [];
        }
        try {
            var parsed = JSON.parse(rawPath);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    function getSchemaFieldAtPath(schemaField, path) {
        var current = isPlainObject(schemaField) ? schemaField : null;
        var i;

        for (i = 0; current && i < path.length; i += 1) {
            if (current.type === "list") {
                current = isPlainObject(current.items) ? current.items : null;
                if (typeof path[i] === "number") {
                    continue;
                }
            }

            if (current && current.type === "object") {
                var properties = isPlainObject(current.properties) ? current.properties : {};
                current = isPlainObject(properties[path[i]]) ? properties[path[i]] : null;
                continue;
            }

            return null;
        }

        return current;
    }

    function getValueAtPath(value, path) {
        var current = value;
        var i;
        for (i = 0; i < path.length; i += 1) {
            if (current === null || typeof current === "undefined") {
                return undefined;
            }
            current = current[path[i]];
        }
        return current;
    }

    function setValueAtPath(rootValue, path, nextValue) {
        if (!path.length) {
            return nextValue;
        }

        var cursor = rootValue;
        var i;
        for (i = 0; i < path.length - 1; i += 1) {
            cursor = cursor[path[i]];
        }
        cursor[path[path.length - 1]] = nextValue;
        return rootValue;
    }

    function fieldPathLabel(field, path) {
        var label = String(field || "");
        path.forEach(function (segment) {
            if (typeof segment === "number") {
                label += "[" + segment + "]";
                return;
            }
            label += "." + segment;
        });
        return label;
    }

    function updateSchemaValue(pluginId, field, rawValue, path) {
        if (!state.selectedProfileDraft || !state.selectedProfileDraft.values[pluginId]) {
            return;
        }

        var pluginDef = state.pluginMap[pluginId] || createUnknownPluginDefinition(pluginId);
        var nextFieldValue = deepClone(state.selectedProfileDraft.values[pluginId][field]);
        var fieldPath = Array.isArray(path) ? path : [];

        if (typeof nextFieldValue === "undefined") {
            nextFieldValue = getDefaultFieldValue(pluginDef, field);
        }

        nextFieldValue = setValueAtPath(nextFieldValue, fieldPath, rawValue);
        state.selectedProfileDraft.values[pluginId][field] = nextFieldValue;
        state.selectedProfileDraft.explicitFields[pluginId] = state.selectedProfileDraft.explicitFields[pluginId] || {};
        state.selectedProfileDraft.explicitFields[pluginId][field] = true;
        updateFieldMessage(pluginId, field, fieldPath);
    }

    function updateFieldMessage(pluginId, field, path) {
        var pluginDef = state.pluginMap[pluginId] || createUnknownPluginDefinition(pluginId);
        var currentValue = state.selectedProfileDraft.values[pluginId][field];
        var defaultValue = getDefaultFieldValue(pluginDef, field);
        var schemaField = pluginDef.config_schema ? pluginDef.config_schema[field] : null;
        var isDefault = deepEqual(
            normalizeSchemaValueForCompare(currentValue, schemaField),
            normalizeSchemaValueForCompare(defaultValue, schemaField)
        );
        setMessage(
            pluginId + "." + fieldPathLabel(field, path || []) + (isDefault ? " 正在使用默认值。" : " 已写入当前编辑态，保存后生效。"),
            "info"
        );
    }

    function addListItem(pluginId, field, path) {
        if (!state.selectedProfileDraft || !state.selectedProfileDraft.values[pluginId]) {
            return;
        }

        var pluginDef = state.pluginMap[pluginId] || createUnknownPluginDefinition(pluginId);
        var schemaField = pluginDef.config_schema ? pluginDef.config_schema[field] : null;
        var listSchema = getSchemaFieldAtPath(schemaField, path || []);
        if (!listSchema || listSchema.type !== "list") {
            return;
        }

        var nextFieldValue = deepClone(state.selectedProfileDraft.values[pluginId][field]);
        var currentList = (path && path.length ? getValueAtPath(nextFieldValue, path) : nextFieldValue);
        var nextList = Array.isArray(currentList) ? currentList.slice() : [];
        nextList.push(emptyValueForSchemaField(listSchema.items || {}));
        nextFieldValue = setValueAtPath(nextFieldValue, path || [], nextList);
        state.selectedProfileDraft.values[pluginId][field] = nextFieldValue;
        state.selectedProfileDraft.explicitFields[pluginId] = state.selectedProfileDraft.explicitFields[pluginId] || {};
        state.selectedProfileDraft.explicitFields[pluginId][field] = true;
        setMessage("已新增 " + pluginId + "." + fieldPathLabel(field, path || []) + " 的列表项。", "info");
        render();
    }

    function removeListItem(pluginId, field, path) {
        if (!state.selectedProfileDraft || !state.selectedProfileDraft.values[pluginId] || !Array.isArray(path) || !path.length) {
            return;
        }

        var itemIndex = path[path.length - 1];
        var listPath = path.slice(0, -1);
        var nextFieldValue = deepClone(state.selectedProfileDraft.values[pluginId][field]);
        var currentList = listPath.length ? getValueAtPath(nextFieldValue, listPath) : nextFieldValue;
        if (!Array.isArray(currentList) || typeof itemIndex !== "number") {
            return;
        }

        var nextList = currentList.slice();
        nextList.splice(itemIndex, 1);
        nextFieldValue = setValueAtPath(nextFieldValue, listPath, nextList);
        state.selectedProfileDraft.values[pluginId][field] = nextFieldValue;
        state.selectedProfileDraft.explicitFields[pluginId] = state.selectedProfileDraft.explicitFields[pluginId] || {};
        state.selectedProfileDraft.explicitFields[pluginId][field] = true;
        setMessage("已删除 " + pluginId + "." + fieldPathLabel(field, path) + "。", "info");
        render();
    }

    function updateCharacterField(field, value) {
        if (!state.selectedProfileDraft || !field) {
            return;
        }
        ensureCharacterDraft(state.selectedProfileDraft)[field] = value;
        setMessage("\u5df2\u66f4\u65b0 character." + field + "\uff0c\u4fdd\u5b58\u540e\u751f\u6548\u3002", "info");
        render();
    }

    function updateTtsPreprocessorField(field, checked) {
        if (!state.selectedProfileDraft || !field) {
            return;
        }
        ensureCharacterDraft(state.selectedProfileDraft).tts_preprocessor[field] = checked;
        setMessage(
            "\u5df2\u66f4\u65b0 character.tts_preprocessor." + field + "\uff0c\u4fdd\u5b58\u540e\u751f\u6548\u3002",
            "info"
        );
        render();
    }

    function updateTtsCharacterName(value) {
        if (!state.selectedProfileDraft) {
            return;
        }
        ensureCharacterDraft(state.selectedProfileDraft).tts.character_name = value;
        setMessage("\u5df2\u66f4\u65b0 character.tts.character_name\uff0c\u4fdd\u5b58\u540e\u751f\u6548\u3002", "info");
        render();
    }

    function renameTtsEmotionKey(oldKey, newKey) {
        if (!state.selectedProfileDraft) {
            return;
        }
        var emotions = ensureCharacterDraft(state.selectedProfileDraft).tts.emotions;
        var previousKey = typeof oldKey === "string" ? oldKey : "";
        var nextKey = typeof newKey === "string" ? newKey : "";
        var currentValue = Object.prototype.hasOwnProperty.call(emotions, previousKey)
            ? normalizeEmotionDraft(emotions[previousKey])
            : normalizeEmotionDraft(null);

        if (previousKey === nextKey) {
            return;
        }

        delete emotions[previousKey];
        emotions[nextKey] = currentValue;
        setMessage("\u5df2\u66f4\u65b0 character.tts.emotions \u7684\u60c5\u7eea\u540d\uff0c\u4fdd\u5b58\u540e\u751f\u6548\u3002", "info");
        render();
    }

    function updateTtsEmotionPath(key, value) {
        if (!state.selectedProfileDraft) {
            return;
        }
        var emotionKey = typeof key === "string" ? key : "";
        var emotions = ensureCharacterDraft(state.selectedProfileDraft).tts.emotions;
        var emotion = normalizeEmotionDraft(emotions[emotionKey]);
        emotion.path = value;
        emotions[emotionKey] = emotion;
        setMessage("\u5df2\u66f4\u65b0 character.tts.emotions \u7684 wav \u8def\u5f84\uff0c\u4fdd\u5b58\u540e\u751f\u6548\u3002", "info");
        render();
    }

    function updateTtsEmotionRefText(key, value) {
        if (!state.selectedProfileDraft) {
            return;
        }
        var emotionKey = typeof key === "string" ? key : "";
        var emotions = ensureCharacterDraft(state.selectedProfileDraft).tts.emotions;
        var emotion = normalizeEmotionDraft(emotions[emotionKey]);
        emotion.ref_text = value;
        emotions[emotionKey] = emotion;
        setMessage("\u5df2\u66f4\u65b0 character.tts.emotions \u7684 ref_text\uff0c\u4fdd\u5b58\u540e\u751f\u6548\u3002", "info");
        render();
    }

    function addTtsEmotion() {
        if (!state.selectedProfileDraft) {
            return;
        }
        var emotions = ensureCharacterDraft(state.selectedProfileDraft).tts.emotions;
        if (!Object.prototype.hasOwnProperty.call(emotions, "")) {
            emotions[""] = normalizeEmotionDraft(null);
        }
        setMessage("\u5df2\u65b0\u589e\u4e00\u884c character.tts.emotions\uff0c\u4fdd\u5b58\u540e\u751f\u6548\u3002", "info");
        render();
    }

    function removeTtsEmotion(key) {
        if (!state.selectedProfileDraft) {
            return;
        }
        delete ensureCharacterDraft(state.selectedProfileDraft).tts.emotions[typeof key === "string" ? key : ""];
        setMessage("\u5df2\u5220\u9664\u4e00\u6761 character.tts.emotions \u6620\u5c04\uff0c\u4fdd\u5b58\u540e\u751f\u6548\u3002", "info");
        render();
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
        if (state.activeTab === "providers") {
            panelEl.innerHTML = renderProvidersTab();
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

    function syncTabFromHash() {
        var hash = String(window.location.hash || "").replace(/^#/, "");
        if (!hash) {
            return;
        }

        var hasTab = tabButtons.some(function (button) {
            return button.getAttribute("data-tab") === hash;
        });
        if (hasTab) {
            state.activeTab = hash;
        }
    }

    function handleHashChange() {
        var previousTab = state.activeTab;
        syncTabFromHash();
        if (state.activeTab !== previousTab) {
            render();
        }
    }

    function updateLocationHash() {
        if (!state.activeTab) {
            return;
        }
        if (window.location.hash === "#" + state.activeTab) {
            return;
        }
        window.location.hash = state.activeTab;
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

        if (state.activeTab === "providers") {
            topbarMetaEl.textContent = state.providers.length + " configured provider(s)";
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
            '  <div class="stack">',
            renderCharacterCardSafe(draft),
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
            "  </div>",
            "</div>"
        ].join("");
    }

    function renderCharacterTtsCard(draft) {
        var characterTts = ensureCharacterTtsDraft(draft);
        var emotions = isPlainObject(characterTts.emotions) ? characterTts.emotions : {};
        var emotionKeys = Object.keys(emotions);

        return [
            '  <section class="card"><div class="card-body stack">',
            '    <div class="section-title">',
            "      <div>",
            "        <h3>Character TTS</h3>",
            '        <p class="muted">缂栬緫 `[character.tts]`锛岀敤浜?GPT-SoVITS 瑙掕壊鍜屾儏缁?ref_audio 鏄犲皠銆?/p>',
            "      </div>",
            "    </div>",
            '    <section class="field">',
            '      <div class="field-top"><div class="field-title">character_name</div></div>',
            '      <p class="field-desc">GPT-SoVITS 瑙掕壊鐩綍鍚嶏紝鐩稿浜?models/gptsovits/銆?/p>',
            '      <input class="input" type="text" placeholder="baoqiao" data-action="update-tts-character-name" value="' + escapeAttribute(displayInputValue(characterTts.character_name)) + '" />',
            "    </section>",
            '    <section class="field">',
            '      <div class="section-title">',
            "        <div>",
            '          <div class="field-title">emotions</div>',
            '          <p class="field-desc">鎯呯华鍚?-> wav 璺緞锛岀浉瀵逛簬 `models/gptsovits/&lt;character_name&gt;/`銆?/p>',
            "        </div>",
            '        <div class="section-actions">',
            '          <button class="button" type="button" data-action="add-tts-emotion">+ 娣诲姞鎯呯华</button>',
            "        </div>",
            "      </div>",
            (
                emotionKeys.length
                    ? ('      <div class="stack">' + emotionKeys.map(function (key) {
                        return renderEmotionRow(key, emotions[key]);
                    }).join("") + "</div>")
                    : '      <div class="empty-copy">No emotion mappings yet.</div>'
            ),
            "    </section>",
            "  </div></section>"
        ].join("");
    }

    function renderEmotionRow(key, value) {
        var emotion = normalizeEmotionDraft(value);
        return [
            '        <div class="stack" data-emotion-key="' + escapeAttribute(key) + '">',
            '          <div class="row">',
            '          <input class="input" type="text" placeholder="鎯呯华鍚?" data-action="update-emotion-key" data-old-key="' + escapeAttribute(key) + '" value="' + escapeAttribute(displayInputValue(key)) + '" />',
            '          <input class="input grow" type="text" placeholder="emotions/neutral.wav" data-action="update-emotion-path" data-key="' + escapeAttribute(key) + '" value="' + escapeAttribute(displayInputValue(emotion.path)) + '" />',
            '          <button class="button is-subtle is-danger" type="button" data-action="remove-emotion" data-key="' + escapeAttribute(key) + '">鍒犻櫎</button>',
            "          </div>",
            '          <input class="input" type="text" placeholder="ref_text (optional)" data-action="update-emotion-ref-text" data-key="' + escapeAttribute(key) + '" value="' + escapeAttribute(displayInputValue(emotion.ref_text)) + '" />',
            "        </div>"
        ].join("");
    }

    function renderCharacterTtsCardSafe(draft) {
        var characterTts = ensureCharacterTtsDraft(draft);
        var emotions = isPlainObject(characterTts.emotions) ? characterTts.emotions : {};
        var emotionKeys = Object.keys(emotions);

        return [
            '  <section class="card"><div class="card-body stack">',
            '    <div class="section-title">',
            "      <div>",
            "        <h3>Character TTS</h3>",
            '        <p class="muted">编辑 `[character.tts]`，用于配置 GPT-SoVITS 的角色目录和情绪 ref_audio 映射。</p>',
            "      </div>",
            "    </div>",
            '    <section class="field">',
            '      <div class="field-top"><div class="field-title">character_name</div></div>',
            '      <p class="field-desc">角色目录名，相对于 `models/gptsovits/`。</p>',
            '      <input class="input" type="text" placeholder="baoqiao" data-action="update-tts-character-name" value="' + escapeAttribute(displayInputValue(characterTts.character_name)) + '" />',
            "    </section>",
            '    <section class="field">',
            '      <div class="section-title">',
            "        <div>",
            '          <div class="field-title">emotions</div>',
            '          <p class="field-desc">情绪名到 wav 路径的映射，路径相对于 `models/gptsovits/&lt;character_name&gt;/`。</p>',
            "        </div>",
            '        <div class="section-actions">',
            '          <button class="button" type="button" data-action="add-tts-emotion">+ 添加情绪</button>',
            "        </div>",
            "      </div>",
            (
                emotionKeys.length
                    ? ('      <div class="stack">' + emotionKeys.map(function (key) {
                        return renderEmotionRowSafe(key, emotions[key]);
                    }).join("") + "</div>")
                    : '      <div class="empty-copy">还没有情绪映射。</div>'
            ),
            "    </section>",
            "  </div></section>"
        ].join("");
    }

    function renderEmotionRowSafe(key, value) {
        var emotion = normalizeEmotionDraft(value);
        return [
            '        <div class="stack" data-emotion-key="' + escapeAttribute(key) + '">',
            '          <div class="row">',
            '          <input class="input" type="text" placeholder="\u60c5\u7eea\u540d" data-action="update-emotion-key" data-old-key="' + escapeAttribute(key) + '" value="' + escapeAttribute(displayInputValue(key)) + '" />',
            '          <input class="input grow" type="text" placeholder="emotions/neutral.wav" data-action="update-emotion-path" data-key="' + escapeAttribute(key) + '" value="' + escapeAttribute(displayInputValue(emotion.path)) + '" />',
            '          <button class="button is-subtle is-danger" type="button" data-action="remove-emotion" data-key="' + escapeAttribute(key) + '">\u5220\u9664</button>',
            "          </div>",
            '          <input class="input" type="text" placeholder="ref_text\uff08\u53ef\u4e3a\u7a7a\uff09" data-action="update-emotion-ref-text" data-key="' + escapeAttribute(key) + '" value="' + escapeAttribute(displayInputValue(emotion.ref_text)) + '" />',
            "        </div>"
        ].join("");
    }

    function renderCharacterCardSafe(draft) {
        var character = ensureCharacterDraft(draft);
        var baseFields = [
            { key: "conf_name", label: "conf_name", placeholder: "baoqiao-local" },
            { key: "conf_uid", label: "conf_uid", placeholder: "baoqiao-local-001" },
            { key: "live2d_model_name", label: "live2d_model_name", placeholder: "Baoqiao" },
            { key: "character_name", label: "character_name", placeholder: "\u89d2\u8272\u540d" },
            { key: "avatar", label: "avatar", placeholder: "baoqiao.png" },
            { key: "human_name", label: "human_name", placeholder: "Human" }
        ];
        var preprocessorFields = [
            {
                key: "remove_special_char",
                label: "remove_special_char",
                description: "\u79fb\u9664 TTS \u6587\u672c\u4e2d\u4e0d\u9002\u5408\u6717\u8bfb\u7684\u7279\u6b8a\u7b26\u53f7\u3002"
            },
            {
                key: "ignore_brackets",
                label: "ignore_brackets",
                description: "\u5ffd\u7565\u4e2d\u62ec\u53f7\u5185\u7684\u5185\u5bb9\uff0c\u4f8b\u5982\u3010\u65c1\u767d\u3011\u6216\u3010\u52a8\u4f5c\u3011\u3002"
            },
            {
                key: "ignore_parentheses",
                label: "ignore_parentheses",
                description: "\u5ffd\u7565\u5706\u62ec\u53f7\u5185\u7684\u5185\u5bb9\uff0c\u4f8b\u5982\uff08\u8865\u5145\u8bf4\u660e\uff09\u3002"
            },
            {
                key: "ignore_asterisks",
                label: "ignore_asterisks",
                description: "\u5ffd\u7565\u661f\u53f7\u5305\u88f9\u7684\u5185\u5bb9\uff0c\u4f8b\u5982 *\u52a8\u4f5c* \u6216 *\u821e\u53f0\u63cf\u5199*\u3002"
            },
            {
                key: "ignore_angle_brackets",
                label: "ignore_angle_brackets",
                description: "\u5ffd\u7565\u5c16\u62ec\u53f7\u5185\u7684\u5185\u5bb9\uff0c\u4f8b\u5982 <think> \u6216\u5176\u4ed6\u6807\u8bb0\u6bb5\u3002"
            }
        ];

        return [
            '  <section class="card"><div class="card-body stack">',
            '    <div class="section-title">',
            "      <div>",
            "        <h3>Character</h3>",
            '        <p class="muted">\u5728\u8fd9\u91cc\u7edf\u4e00\u7f16\u8f91 `[character]` \u7684\u57fa\u7840\u4fe1\u606f\u3001TTS \u9884\u5904\u7406\u4ee5\u53ca Character TTS \u914d\u7f6e\u3002</p>',
            "      </div>",
            "    </div>",
            '    <section class="field stack">',
            '      <div class="field-top"><div class="field-title">\u57fa\u7840\u4fe1\u606f</div></div>',
            '      <div class="fields">',
            baseFields.map(function (field) {
                return renderCharacterTextField(field, character[field.key]);
            }).join(""),
            "      </div>",
            "    </section>",
            '    <section class="field stack">',
            '      <div class="field-top"><div class="field-title">TTS Preprocessor</div></div>',
            '      <div class="fields">',
            preprocessorFields.map(function (field) {
                return renderCharacterCheckboxField(field, character.tts_preprocessor[field.key]);
            }).join(""),
            "      </div>",
            "    </section>",
            renderCharacterTtsSection(character.tts),
            "  </div></section>"
        ].join("");
    }

    function renderCharacterTextField(field, value) {
        return [
            '        <section class="field">',
            '          <div class="field-top"><div class="field-title">' + escapeHtml(field.label) + "</div></div>",
            '          <input class="input" type="text" data-action="update-character-field" data-field="' + escapeAttribute(field.key) + '" placeholder="' + escapeAttribute(field.placeholder) + '" value="' + escapeAttribute(displayInputValue(value)) + '" />',
            "        </section>"
        ].join("");
    }

    function renderCharacterCheckboxField(field, checked) {
        return [
            '        <section class="field">',
            '          <div class="field-top">',
            '            <div class="field-title">' + escapeHtml(field.label) + "</div>",
            '            <input type="checkbox" data-action="update-tts-preprocessor" data-field="' + escapeAttribute(field.key) + '"' + (checked ? " checked" : "") + " />",
            "          </div>",
            '          <p class="field-desc">' + escapeHtml(field.description || "") + "</p>",
            "        </section>"
        ].join("");
    }

    function renderCharacterTtsSection(tts) {
        var emotions = isPlainObject(tts.emotions) ? tts.emotions : {};
        var emotionKeys = Object.keys(emotions);

        return [
            '    <section class="field stack">',
            '      <div class="field-top"><div class="field-title">Character TTS</div></div>',
            '      <section class="field">',
            '        <div class="field-top"><div class="field-title">character_name</div></div>',
            '        <p class="field-desc">\u89d2\u8272\u76ee\u5f55\u540d\uff0c\u76f8\u5bf9\u4e8e `models/gptsovits/`\u3002</p>',
            '        <input class="input" type="text" placeholder="baoqiao" data-action="update-tts-character-name" value="' + escapeAttribute(displayInputValue(tts.character_name)) + '" />',
            "      </section>",
            '      <section class="field">',
            '        <div class="section-title">',
            "          <div>",
            '            <div class="field-title">emotions</div>',
            '            <p class="field-desc">\u60c5\u7eea\u540d\u5bf9\u5e94 path \u4e0e ref_text\uff0cpath \u76f8\u5bf9\u4e8e `models/gptsovits/&lt;character_name&gt;/`\uff0cref_text \u53ef\u4e3a\u7a7a\uff0c\u7a7a\u65f6\u4e0d\u4f20\u3002</p>',
            "          </div>",
            '          <div class="section-actions">',
            '            <button class="button" type="button" data-action="add-tts-emotion">+ \u6dfb\u52a0\u60c5\u7eea</button>',
            "          </div>",
            "        </div>",
            (
                emotionKeys.length
                    ? ('        <div class="stack">' + emotionKeys.map(function (key) {
                        return renderEmotionRowSafe(key, emotions[key]);
                    }).join("") + "</div>")
                    : '        <div class="empty-copy">\u8fd8\u6ca1\u6709\u60c5\u7eea\u6620\u5c04\u3002</div>'
            ),
            "      </section>",
            "    </section>"
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
        var usingDefault = deepEqual(
            normalizeSchemaValueForCompare(currentValue, schemaField),
            normalizeSchemaValueForCompare(defaultValue, schemaField)
        );
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
            '    <div class="badges">' + badges.join("") + '<button class="button is-subtle" type="button" data-action="reset-field" data-plugin-id="' + escapeAttribute(pluginId) + '" data-field="' + escapeAttribute(field) + '">恢复默认</button></div>',
            "  </div>",
            '  <p class="field-desc">' + escapeHtml(schemaField.description || "No description") + "</p>",
            renderSchemaNode(pluginId, field, schemaField, currentValue, [], field),
            '  <div class="field-meta">默认值: ' + escapeHtml(displayValue(defaultValue)) + extraNumberMeta(schemaField) + "</div>",
            "</section>"
        ].join("");
    }

    function renderSchemaNode(pluginId, field, schemaField, currentValue, path, label) {
        if (schemaField.type === "object") {
            return renderObjectSchemaNode(pluginId, field, schemaField, currentValue, path);
        }
        if (schemaField.type === "list") {
            return renderListSchemaNode(pluginId, field, schemaField, currentValue, path);
        }
        return renderPrimitiveSchemaNode(pluginId, field, schemaField, currentValue, path, label);
    }

    function renderObjectSchemaNode(pluginId, field, schemaField, currentValue, path) {
        var properties = isPlainObject(schemaField.properties) ? schemaField.properties : {};
        var objectValue = isPlainObject(currentValue) ? currentValue : emptyValueForSchemaField(schemaField);
        var keys = Object.keys(properties);

        if (!keys.length) {
            return '<div class="empty-copy">This object has no editable fields.</div>';
        }

        return [
            '<div class="nested-fields">',
            keys.map(function (key) {
                return renderNestedSchemaField(pluginId, field, properties[key], objectValue[key], path.concat(key), key);
            }).join(""),
            "</div>"
        ].join("");
    }

    function renderListSchemaNode(pluginId, field, schemaField, currentValue, path) {
        var itemSchema = isPlainObject(schemaField.items) ? schemaField.items : {};
        var items = Array.isArray(currentValue) ? currentValue : [];
        var pathAttr = escapeAttribute(JSON.stringify(path || []));

        return [
            '<div class="list-editor">',
            '  <div class="list-toolbar">',
            '    <p class="note">按当前顺序保存为对象列表。</p>',
            '    <button class="button" type="button" data-action="add-list-item" data-plugin-id="' + escapeAttribute(pluginId) + '" data-field="' + escapeAttribute(field) + '" data-field-path="' + pathAttr + '">新增 item</button>',
            "  </div>",
            items.length
                ? ('  <div class="list-items">' + items.map(function (item, index) {
                    return renderListSchemaItem(pluginId, field, itemSchema, item, path.concat(index), index);
                }).join("") + "</div>")
                : '  <div class="empty-copy">No items yet.</div>',
            "</div>"
        ].join("");
    }

    function renderListSchemaItem(pluginId, field, itemSchema, itemValue, itemPath, index) {
        return [
            '<section class="list-item-card">',
            '  <div class="list-item-head">',
            '    <div class="list-item-anchor"></div>',
            '    <button class="button is-subtle is-danger" type="button" data-action="remove-list-item" data-plugin-id="' + escapeAttribute(pluginId) + '" data-field="' + escapeAttribute(field) + '" data-field-path="' + escapeAttribute(JSON.stringify(itemPath)) + '">删除</button>',
            "  </div>",
            renderSchemaNode(pluginId, field, itemSchema, itemValue, itemPath, field),
            "</section>"
        ].join("");
    }

    function renderNestedSchemaField(pluginId, field, schemaField, currentValue, path, label) {
        return [
            '<section class="nested-field">',
            '  <div class="nested-field-head">',
            '    <div class="field-title">' + escapeHtml(label) + "</div>",
            (schemaField.type ? ('    <span class="badge is-muted">' + escapeHtml(schemaField.type) + "</span>") : ""),
            "  </div>",
            schemaField.description ? ('  <p class="field-desc">' + escapeHtml(schemaField.description) + "</p>") : "",
            renderSchemaNode(pluginId, field, schemaField, currentValue, path, label),
            "</section>"
        ].join("");
    }

    function renderPrimitiveSchemaNode(pluginId, field, schemaField, currentValue, path, label) {
        var common =
            ' data-plugin-id="' +
            escapeAttribute(pluginId) +
            '" data-field="' +
            escapeAttribute(field) +
            '" data-field-path="' +
            escapeAttribute(JSON.stringify(path || [])) +
            '"';

        if (schemaField.type === "bool") {
            return [
                '<div class="field-input-row">',
                '  <label class="toggle">',
                '    <input type="checkbox" data-field-type="bool"' + common + (Boolean(currentValue) ? " checked" : "") + ">",
                '    <span>' + (Boolean(currentValue) ? "Enabled" : "Disabled") + "</span>",
                "  </label>",
                "</div>"
            ].join("");
        }

        if (schemaField.type === "str" && label === "description") {
            return [
                '<div class="field-input-row">',
                '  <textarea class="textarea compact-textarea" data-field-type="str"' + common + ">" + escapeHtml(displayInputValue(currentValue)) + "</textarea>",
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

    function renderProvidersTab() {
        if (state.loading.boot) {
            return renderPlaceholder("正在读取 Providers", "等待 `/admin/api/providers` 和 `/admin/api/config/agent` 返回结果...");
        }

        return [
            '<div class="plugins-grid">',
            '  <section class="card"><div class="card-body stack">',
            '    <div class="section-title">',
            "      <div>",
            "        <h3>LLM Providers</h3>",
            '        <p class="muted">维护 `lab.toml` 中的 `[[agent.llm.providers]]`，保存后自动触发 agent reload。</p>',
            "      </div>",
            "    </div>",
            renderProviderCreateCard(),
            renderProviderList(),
            "  </div></section>",
            '  <section class="card"><div class="card-body stack">',
            '    <div class="section-title">',
            "      <div>",
            "        <h3>Agent Models</h3>",
            '        <p class="muted">为 Chat Model 和 Vision Model 选择 provider，并填写模型名。</p>',
            "      </div>",
            "    </div>",
            renderAgentConfigCard(),
            "  </div></section>",
            "</div>"
        ].join("");
    }

    function renderProviderCreateCard() {
        var disabled = state.loading.providerSave ? "disabled" : "";
        return [
            '    <section class="field stack">',
            '      <div class="field-top"><div class="field-title">新增 Provider</div></div>',
            '      <div class="fields">',
            '        <input class="input" type="text" placeholder="name" data-action="update-new-provider-name" value="' + escapeAttribute(displayInputValue(state.newProviderDraft.name)) + '" />',
            '        <input class="input" type="text" placeholder="https://api.example.com/v1" data-action="update-new-provider-base-url" value="' + escapeAttribute(displayInputValue(state.newProviderDraft.base_url)) + '" />',
            '        <select class="select" data-action="update-new-provider-api-format"><option value="chat_completion"' + (state.newProviderDraft.api_format === "chat_completion" ? " selected" : "") + '>chat_completion</option></select>',
            '        <input class="input" type="password" placeholder="api key" data-action="update-new-provider-api-key" value="' + escapeAttribute(displayInputValue(state.newProviderDraft.api_key)) + '" />',
            "      </div>",
            '      <div class="row">',
            '        <button class="button is-primary" type="button" data-action="create-provider" ' + disabled + ">创建并重载</button>",
            '        <div class="field-meta">name 必填；base_url 和 api_key 可稍后修改。</div>',
            "      </div>",
            "    </section>"
        ].join("");
    }

    function renderProviderList() {
        if (!state.providers.length) {
            return '<div class="empty-copy">还没有 provider，先创建一个 provider，然后再为 chat / vision model 选择它。</div>';
        }

        return [
            '    <div class="stack">',
            state.providers.map(function (provider) {
                return renderProviderCard(provider);
            }).join(""),
            "    </div>"
        ].join("");
    }

    function renderProviderCard(provider) {
        var draft = state.providerDrafts[provider.name] || {
            name: provider.name,
            base_url: provider.base_url || "",
            api_key: "",
            api_format: provider.api_format || "chat_completion",
            api_key_masked: provider.api_key_masked || "",
            has_api_key: Boolean(provider.has_api_key)
        };
        var disabled = state.loading.providerSave ? "disabled" : "";

        return [
            '    <section class="field stack">',
            '      <div class="field-top">',
            "        <div>",
            '          <div class="field-title">' + escapeHtml(provider.name) + "</div>",
            '          <p class="field-desc">当前 API Key：' + escapeHtml(provider.api_key_masked || "未设置") + "</p>",
            "        </div>",
            '        <div class="badges">',
            '          <span class="badge is-muted">' + escapeHtml(provider.name) + "</span>",
            '          <span class="badge ' + (provider.has_api_key ? "is-success" : "is-warning") + '">' + (provider.has_api_key ? "key set" : "no key") + "</span>",
            "        </div>",
            "      </div>",
            '      <div class="fields">',
            '        <input class="input" type="text" data-action="update-provider-base-url" data-provider-name="' + escapeAttribute(provider.name) + '" value="' + escapeAttribute(displayInputValue(draft.base_url)) + '" />',
            '        <select class="select" data-action="update-provider-api-format" data-provider-name="' + escapeAttribute(provider.name) + '"><option value="chat_completion"' + (draft.api_format === "chat_completion" ? " selected" : "") + '>chat_completion</option></select>',
            '        <input class="input" type="password" data-action="update-provider-api-key" data-provider-name="' + escapeAttribute(provider.name) + '" placeholder="留空则保持当前 key" value="' + escapeAttribute(displayInputValue(draft.api_key)) + '" />',
            "      </div>",
            '      <div class="row">',
            '        <button class="button is-primary" type="button" data-action="save-provider" data-provider-name="' + escapeAttribute(provider.name) + '" ' + disabled + ">保存并重载</button>",
            '        <button class="button is-subtle is-danger" type="button" data-action="delete-provider" data-provider-name="' + escapeAttribute(provider.name) + '" ' + disabled + ">删除</button>",
            "      </div>",
            "    </section>"
        ].join("");
    }

    function renderAgentConfigCard() {
        if (!state.agentConfigDraft) {
            return '<div class="empty-copy">正在读取 Agent 配置，请稍候。</div>';
        }

        var disabled = state.loading.agentConfigSave ? "disabled" : "";

        return [
            renderAgentModelEditor("chat_model", "Chat Model", state.agentConfigDraft.chat_model),
            renderAgentModelEditor("vision_model", "Vision Model", state.agentConfigDraft.vision_model),
            '    <div class="row">',
            '      <button class="button is-primary" type="button" data-action="save-agent-config" ' + disabled + ">" + (state.loading.agentConfigSave ? "保存中..." : "保存并重载") + "</button>",
            '      <div class="field-meta">provider 选项来自 `/admin/api/providers`。</div>',
            "    </div>"
        ].join("");
    }

    function renderAgentModelEditor(modelKind, label, config) {
        return [
            '    <section class="field stack">',
            '      <div class="field-top"><div class="field-title">' + escapeHtml(label) + "</div></div>",
            '      <div class="fields">',
            '        <div>',
            '          <label class="label">Provider</label>',
            '          <select class="select" data-action="update-agent-provider" data-model-kind="' + escapeAttribute(modelKind) + '">',
            renderProviderOptions(config.llm_provider),
            "          </select>",
            "        </div>",
            '        <div>',
            '          <label class="label">Model Name</label>',
            '          <input class="input" type="text" data-action="update-agent-model-name" data-model-kind="' + escapeAttribute(modelKind) + '" value="' + escapeAttribute(displayInputValue(config.llm_model_name)) + '" />',
            "        </div>",
            "      </div>",
            "    </section>"
        ].join("");
    }

    function renderProviderOptions(selectedName) {
        if (!state.providers.length) {
            return '<option value="">No providers available</option>';
        }

        return state.providers.map(function (provider) {
            var selected = provider.name === selectedName ? " selected" : "";
            return '<option value="' + escapeAttribute(provider.name) + '"' + selected + ">" + escapeHtml(provider.name) + "</option>";
        }).join("");
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
