/**
 * 国际化工具 - 支持中文和英文
 */

// 获取版本号（构建时会替换为实际版本号）
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';

export const translations = {
    'zh-CN': {
        // 顶部控制栏
        'visual': '视觉',
        'collision': '碰撞',
        'com': '质心',
        'inertia': '惯量',
        'axes': '坐标轴',
        'jointAxes': '关节轴',
        'shadow': '阴影',
        'lighting': '光照',
        'files': '文件',
        'joints': '关节',
        'structure': '结构',
        'edit': '编辑',
        'help': '帮助',
        'theme': '主题',
        'language': '语言',

        // 面板标题
        'fileList': '文件',
        'jointControl': '关节',
        'modelStructure': '结构',
        'codeEditor': '编辑',

        // 关节控制
        'radian': '弧度',
        'degree': '角度',
        'reset': '重置',
        'limits': '限位',

        // MuJoCo 仿真
        'mujocoReset': '重置',
        'mujocoSimulate': '仿真',
        'mujocoPause': '暂停',

        // 代码编辑器
        'reload': '重新加载',
        'download': '下载',
        'saved': '已保存',
        'unsaved': '未保存',
        'noFileOpen': '未打开文件',

        // 姿态配置
        'jointPoseTitle': '姿态配置',
        'jointPoseGroupsField': '关节分组',
        'jointPoseValuesField': '姿态数值 (rad)',
        'jointPoseApply': '应用',
        'jointPoseCopyValues': '复制数值',
        'jointPoseGroupsPlaceholder': 'waist: [joint_a, joint_b]\narm: [joint_c, joint_d]',
        'jointPoseValuesPlaceholder': 'waist: [0.0, 0.0]\narm: [0.9, -0.9]',
        'jointPoseConfigEdited': '姿态配置已修改，点击“应用”后恢复联动。',
        'jointPoseReapplyRequired': '已保留姿态配置，请对当前模型重新点击“应用”。',
        'jointPoseApplySuccess': '姿态应用成功。',
        'jointPoseApplyClamped': '姿态已应用，有 {count} 个关节值被裁剪到当前限位范围。',
        'jointPoseCopySuccess': '姿态数值已复制。',
        'jointPoseCopyFailed': '复制姿态数值失败：{reason}',
        'jointPoseClipboardUnavailable': '当前环境不支持剪贴板复制。',
        'jointPoseGroupsRequired': '请先填写关节分组 YAML。',
        'jointPoseValuesRequired': '请先填写姿态数值 YAML。',
        'jointPoseYamlParseFailed': '解析 {field} 失败：{reason}',
        'jointPoseMappingExpected': '{field} 必须是 YAML 映射。',
        'jointPoseSequenceExpected': '{field}.{group} 必须是数组。',
        'jointPoseGroupNameRequired': '{field} 中包含空的分组名称。',
        'jointPoseGroupDuplicate': '{field} 中的分组 {group} 重复定义。',
        'jointPoseJointNameInvalid': '{field}.{group}[{index}] 必须是非空关节名字符串。',
        'jointPoseValueInvalid': '{field}.{group}[{index}] 必须是有限数字。',
        'jointPoseGroupMismatch': '关节分组和姿态数值必须包含完全相同的分组。',
        'jointPoseGroupOrderMismatch': '姿态数值的分组顺序必须与关节分组一致。',
        'jointPoseLengthMismatch': '分组 {group} 中关节数量为 {jointCount}，数值数量为 {valueCount}。',
        'jointPoseJointMissing': '当前模型中不存在关节 {joint}。',
        'jointPoseJointFixed': '关节 {joint} 是 fixed，无法控制。',
        'jointPoseJointDuplicate': '关节 {joint} 被重复分配。',

        // 帮助对话框
        'helpTitle': `Robot Viewer v${APP_VERSION}`,
        'about': '关于',
        'aboutContent': 'Robot Viewer 是一个基于 Three.js 的网页端机器人模型 3D 查看器，提供直观的可视化界面，帮助您在浏览器中查看和分析机器人的结构、关节和物理属性，无需安装任何软件。<br><br>格式支持：URDF、Xacro、MJCF、USD（部分支持）<br>机器人类型：串联机器人结构（暂不支持并联机器人）<br><br>由 <strong>范子琦</strong> 开发。',
        'projectHome': '项目主页',
        'email': '邮箱',
        'myGithub': '我的GitHub',
        'operations': '操作指南',
        'leftDrag': '左键拖动',
        'rotateView': '旋转视角',
        'rightDrag': '右键拖动',
        'panView': '平移视角',
        'scroll': '滚轮',
        'zoom': '缩放视图',
        'clickModel': '点击模型',
        'controlJoint': '控制关节（可拖动）',
        'dragFile': '拖拽文件',
        'loadModel': '加载机器人模型',
        'contact': '联系方式',
        'support': '支持',

        // 其他
        'noFolder': '未加载文件夹',
        'noModel': '未加载模型',
        'load': '加载',
        'loadFiles': '加载文件',
        'loadFolder': '加载文件夹',
        'orClickButton': '或点击下面的按钮加载',
        'noControllableJoints': '未找到可控制关节',
        'clickToEditMin': '点击编辑下限',
        'clickToEditMax': '点击编辑上限',
        'dropHint': '拖拽机器人模型文件或文件夹到页面任意位置',
        'dropHintSub': '支持 URDF, Xacro, MJCF 格式<br>支持拖拽文件夹以加载mesh文件',
        'graphHint': '拖动: 移动 | 滚轮: 缩放 | 右键: 隐藏/显示 | Ctrl+左键: 测量',
        'copyright': '© 2025 范子琦 版权所有。',

        // 模型信息
        'type': '类型',
        'links': 'Links',
        'joints': '关节',
        'controllable': '可控',
        'rootLink': '根Link',

        // 悬浮信息
        'linkName': 'Link名称',
        'jointName': '关节',
        'mass': '质量',
        'mergedLinks': '合并的Links',

        // 文件类型
        'model': '模型',
        'mesh': '网格',
        'link': '链接',

        // 单位
        'kg': 'kg',
        'rad': 'rad',
        'deg': 'deg',
        'm': 'm',

        // 状态消息
        'loading': '正在加载',
        'unsupportedFormat': '不支持的文件格式',
        'loadFailed': '加载失败',
        'noSupportedFiles': '未找到支持的文件（URDF, Xacro, MJCF, DAE, STL, OBJ）',
        'loadSuccess': '模型加载成功',
        'cannotLoadMesh': '无法加载 mesh 文件',

        // 编辑器消息
        'unsavedChanges': '您有未保存的更改，确定要关闭吗？',
        'newFile': '新文件.xml',
        'noFileToReload': '没有可重新加载的文件',
        'saveFirst': '请先保存为文件后再加载',
        'reloadingModel': '正在重新加载模型...',
        'modelReloaded': '模型已重新加载（未保存）',
        'reloadFailed': '重新加载失败',
        'downloadFailed': '下载失败',
        'fileDownloaded': '文件已下载',
        'emptyContent': '编辑器内容为空，无法加载',
        'fileType': '文件类型'
    },
    'en-US': {
        // Top control bar
        'visual': 'Visual',
        'collision': 'Collision',
        'com': 'COM',
        'inertia': 'Inertia',
        'axes': 'Axes',
        'jointAxes': 'Joint Axes',
        'shadow': 'Shadow',
        'lighting': 'Lighting',
        'files': 'Files',
        'joints': 'Joints',
        'structure': 'Structure',
        'edit': 'Edit',
        'help': 'Help',
        'theme': 'Theme',
        'language': 'Language',

        // Panel titles
        'fileList': 'Files',
        'jointControl': 'Joints',
        'modelStructure': 'Structure',
        'codeEditor': 'Editor',

        // Joint control
        'radian': 'Radian',
        'degree': 'Degree',
        'reset': 'Reset',
        'limits': 'Limits',

        // MuJoCo simulation
        'mujocoReset': 'Reset',
        'mujocoSimulate': 'Simulate',
        'mujocoPause': 'Pause',

        // Code editor
        'reload': 'Reload',
        'download': 'Download',
        'saved': 'Saved',
        'unsaved': 'Unsaved',
        'noFileOpen': 'No File Open',

        // Pose config
        'jointPoseTitle': 'Pose Config',
        'jointPoseGroupsField': 'Joint Groups',
        'jointPoseValuesField': 'Pose Values (rad)',
        'jointPoseApply': 'Apply',
        'jointPoseCopyValues': 'Copy Values',
        'jointPoseGroupsPlaceholder': 'waist: [joint_a, joint_b]\narm: [joint_c, joint_d]',
        'jointPoseValuesPlaceholder': 'waist: [0.0, 0.0]\narm: [0.9, -0.9]',
        'jointPoseConfigEdited': 'Pose config changed. Click Apply to resume syncing.',
        'jointPoseReapplyRequired': 'Pose config was kept. Click Apply to use it with the current model.',
        'jointPoseApplySuccess': 'Pose applied successfully.',
        'jointPoseApplyClamped': 'Pose applied. {count} joint values were clamped to the current limits.',
        'jointPoseCopySuccess': 'Pose values copied to clipboard.',
        'jointPoseCopyFailed': 'Failed to copy pose values: {reason}',
        'jointPoseClipboardUnavailable': 'Clipboard is unavailable in this browser context.',
        'jointPoseGroupsRequired': 'Joint groups YAML is required.',
        'jointPoseValuesRequired': 'Pose values YAML is required.',
        'jointPoseYamlParseFailed': 'Failed to parse {field}: {reason}',
        'jointPoseMappingExpected': '{field} must be a YAML mapping.',
        'jointPoseSequenceExpected': '{field}.{group} must be an array.',
        'jointPoseGroupNameRequired': '{field} contains an empty group name.',
        'jointPoseGroupDuplicate': 'Group {group} is declared more than once in {field}.',
        'jointPoseJointNameInvalid': '{field}.{group}[{index}] must be a non-empty joint name string.',
        'jointPoseValueInvalid': '{field}.{group}[{index}] must be a finite number.',
        'jointPoseGroupMismatch': 'Joint groups and pose values must contain the same groups.',
        'jointPoseGroupOrderMismatch': 'Pose values must use the same group order as joint groups.',
        'jointPoseLengthMismatch': 'Group {group} has {jointCount} joints but {valueCount} values.',
        'jointPoseJointMissing': 'Joint {joint} does not exist in the current model.',
        'jointPoseJointFixed': 'Joint {joint} is fixed and cannot be controlled.',
        'jointPoseJointDuplicate': 'Joint {joint} is assigned more than once.',

        // Help dialog
        'helpTitle': `Robot Viewer v${APP_VERSION}`,
        'about': 'About',
        'aboutContent': 'Robot Viewer is a web-based 3D viewer for robot models and scenes. Built on top of Three.js, it provides an intuitive interface for visualizing, editing, and simulating robots directly in the browser without any installation required. This tool helps you visualize and analyze robot structures, joints, and physical properties.<br><br>Format Support: URDF, Xacro, MJCF, USD (partial support)<br>Robot Types: Serial robot structures (parallel robots not currently supported)<br><br>Developed by <strong>Ziqi Fan</strong>.',
        'projectHome': 'Project Home',
        'email': 'Email',
        'myGithub': 'My GitHub',
        'operations': 'Operations',
        'leftDrag': 'Left Drag',
        'rotateView': 'Rotate View',
        'rightDrag': 'Right Drag',
        'panView': 'Pan View',
        'scroll': 'Scroll',
        'zoom': 'Zoom',
        'clickModel': 'Click Model',
        'controlJoint': 'Control Joint (Draggable)',
        'dragFile': 'Drag File',
        'loadModel': 'Load Robot Model',
        'contact': 'Contact',
        'support': 'Support',

        // Others
        'noFolder': 'No Folder Loaded',
        'noModel': 'No Model Loaded',
        'load': 'Load',
        'loadFiles': 'Load Files',
        'loadFolder': 'Load Folder',
        'orClickButton': 'or click the button below to load',
        'noControllableJoints': 'No Controllable Joints Found',
        'clickToEditMin': 'Click to edit minimum',
        'clickToEditMax': 'Click to edit maximum',
        'dropHint': 'Drag and drop robot model files or folders anywhere',
        'dropHintSub': 'Supports URDF, Xacro, MJCF formats<br>Supports folder dragging to load mesh files',
        'graphHint': 'Drag: Move | Scroll: Zoom | Right-click: Hide/Show | Ctrl+Click: Measure',
        'copyright': '© 2025 Ziqi Fan. All rights reserved.',

        // Model info
        'type': 'Type',
        'links': 'Links',
        'joints': 'Joints',
        'controllable': 'Controllable',
        'rootLink': 'Root Link',

        // Hover info
        'linkName': 'Link Name',
        'jointName': 'Joint',
        'mass': 'Mass',
        'mergedLinks': 'Merged Links',

        // File types
        'model': 'Model',
        'mesh': 'Mesh',
        'link': 'Link',

        // Units
        'kg': 'kg',
        'rad': 'rad',
        'deg': 'deg',
        'm': 'm',

        // Status messages
        'loading': 'Loading',
        'unsupportedFormat': 'Unsupported file format',
        'loadFailed': 'Load failed',
        'noSupportedFiles': 'No supported files found (URDF, Xacro, MJCF, DAE, STL, OBJ)',
        'loadSuccess': 'Model loaded successfully',
        'cannotLoadMesh': 'Cannot load mesh file',

        // Editor messages
        'unsavedChanges': 'You have unsaved changes. Are you sure you want to close?',
        'newFile': 'newfile.xml',
        'noFileToReload': 'No file to reload',
        'saveFirst': 'Please save the file first before loading',
        'reloadingModel': 'Reloading model...',
        'modelReloaded': 'Model reloaded (unsaved)',
        'reloadFailed': 'Reload failed',
        'downloadFailed': 'Download failed',
        'fileDownloaded': 'File downloaded',
        'emptyContent': 'Editor content is empty, cannot load',
        'fileType': 'File Type'
    }
};

class I18n {
    constructor() {
        // 检测浏览器语言
        const browserLang = this.detectBrowserLanguage();
        // 从localStorage读取语言设置，如果没有则使用浏览器语言
        this.currentLang = localStorage.getItem('language') || browserLang;
    }

    /**
     * 检测浏览器语言
     */
    detectBrowserLanguage() {
        const lang = navigator.language || navigator.userLanguage;
        // 如果浏览器语言是中文（包括zh, zh-CN, zh-TW等），返回zh-CN
        if (lang.toLowerCase().startsWith('zh')) {
            return 'zh-CN';
        }
        // 否则默认返回英文
        return 'en-US';
    }

    /**
     * 获取翻译文本
     */
    t(key) {
        const lang = translations[this.currentLang] || translations['zh-CN'];
        return lang[key] || key;
    }

    /**
     * 切换语言
     */
    setLanguage(lang) {
        if (translations[lang]) {
            this.currentLang = lang;
            localStorage.setItem('language', lang);
            this.updatePageLanguage();
        }
    }

    /**
     * 获取当前语言
     */
    getCurrentLanguage() {
        return this.currentLang;
    }

    /**
     * 更新页面上所有带有data-i18n属性的元素
     */
    updatePageLanguage() {
        // 更新所有带有data-i18n属性的元素
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const text = this.t(key);

            // 如果是input或textarea，更新placeholder
            if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                element.placeholder = text;
            } else {
                // 如果包含HTML标签（如<br>），使用innerHTML
                if (text.includes('<br>') || text.includes('<strong>')) {
                    element.innerHTML = text;
                } else {
                    element.textContent = text;
                }
            }
        });

        // 更新HTML lang属性
        document.documentElement.lang = this.currentLang;
    }

    /**
     * 初始化页面语言
     */
    init() {
        this.updatePageLanguage();
    }
}

// 创建全局实例
export const i18n = new I18n();

