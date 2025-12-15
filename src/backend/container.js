// src/backend/container.js

/**
 * @class DIContainer
 * @description 一个轻量级的依赖注入（DI）容器，用于管理服务的生命周期和依赖关系。
 */
export class DIContainer {
    // #registry 用于存储服务“蓝图”（类、依赖、生命周期）
    #registry = new Map();
    // #instances 用于缓存已创建的单例服务
    #instances = new Map();
    // #resolving 用于在解析依赖时检测循环引用
    #resolving = new Set();

    /**
     * 注册一个服务类到容器。
     * @param {string} name - 服务的唯一标识符 (例如 'downloadService')。
     * @param {Function} Class - 服务的构造函数。
     * @param {string[]} dependencies - 一个字符串数组，列出该服务构造函数所需的依赖项名称。
     *                                  顺序必须与构造函数参数的顺序完全一致。
     * @param {object} [options={ singleton: true }] - 配置项, { singleton: true } 表示应用全局只创建一个实例。
     */
    register(name, Class, dependencies = [], options = { singleton: true }) {
        if (this.#registry.has(name)) {
            console.warn(`[DI Container] 服务 "${name}" 已被注册，本次注册将覆盖之前的定义。`);
        }
        this.#registry.set(name, { type: 'class', Class, dependencies, options });
    }

    /**
     * 注册一个静态值到容器，例如配置对象或字符串路径。
     * @param {string} name - 值的唯一标识符 (例如 'config')。
     * @param {*} value - 要注册的实际值。
     */
    registerValue(name, value) {
        if (this.#registry.has(name)) {
            console.warn(`[DI Container] 值 "${name}" 已被注册，本次注册将覆盖之前的定义。`);
        }
        this.#registry.set(name, { type: 'value', value });
    }

    /**
     * 从容器中获取一个服务实例或值。
     * @param {string} name - 要获取的服务或值的名称。
     * @returns {*} - 解析后的服务实例或值。
     */
    get(name) {
        // --- 1. 检查是否正在解析，以防止循环依赖 ---
        if (this.#resolving.has(name)) {
            throw new Error(`[DI Container] 检测到循环依赖: ${[...this.#resolving, name].join(' -> ')}`);
        }

        const definition = this.#registry.get(name);
        if (!definition) {
            throw new Error(`[DI Container] 尝试获取未注册的服务或值: "${name}"`);
        }

        // --- 2. 如果是静态值，直接返回 ---
        if (definition.type === 'value') {
            return definition.value;
        }

        const { Class, dependencies, options } = definition;

        // --- 3. 如果是单例且已有实例，直接从缓存返回 ---
        if (options.singleton && this.#instances.has(name)) {
            return this.#instances.get(name);
        }

        // --- 4. 解析并创建新实例 ---
        this.#resolving.add(name); // 标记为正在解析

        try {
            // 递归调用 get() 来解析所有依赖项
            const resolvedDependencies = dependencies.map(depName => this.get(depName));

            // 使用解析出的依赖项来实例化服务
            const instance = new Class(...resolvedDependencies);

            // 如果是单例，存入缓存
            if (options.singleton) {
                this.#instances.set(name, instance);
            }

            return instance;

        } catch (error) {
            // 确保在出错时能正确地向上抛出异常
            console.error(`[DI Container] 解析服务 "${name}" 时发生错误:`, error);
            throw error;
        } finally {
            // 无论成功与否，都要将服务名从“正在解析”集合中移除
            this.#resolving.delete(name);
        }
    }
}