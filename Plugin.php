<?php

/**
 * Typecho Markdown 编辑器「图片一一对照」
 *
 * 左侧图片链接行贴编号缩略图，右侧预览图打同号角标；
 * 点击右侧图片，左侧自动跳到对应的链接行尾并聚焦，可直接接着码字。
 * 
 *
 * @package EditorImageSync
 * @author 云心怀鹤
 * @version 1.0.1
 * @link https://bluehe.cn/archives/editorimagesync-typecho
 * @dependence 1.2.0
 */

namespace TypechoPlugin\EditorImageSync;

use Typecho\Common;
use Typecho\Plugin\PluginInterface;
use Typecho\Widget\Helper\Form;
use Typecho\Widget\Helper\Form\Element\Checkbox;
use Typecho\Widget\Helper\Form\Element\Text;
use Widget\Options;

if (!defined('__TYPECHO_ROOT_DIR__')) {
    exit;
}

class Plugin implements PluginInterface
{
    /** 插件目录名，必须与 usr/plugins/ 下的目录一致 */
    public const NAME = 'EditorImageSync';

    /** 静态资源相对插件根目录的路径 */
    private const ASSETS = 'EditorImageSync/assets/';

    /** 配置默认值 */
    private const DEFAULTS = [
        'sync'          => true,
        'numbering'     => true,
        'clickToLocate' => true,
        'followCursor'  => true,
        'showTag'       => true,
        'thumbWidth'    => 68
    ];

    /**
     * 启用插件：注册后台钩子
     *
     * header        -> 注入样式表
     * write         -> 注入配置与主脚本（在 editor-js.php 之前，可覆盖原生 scrollableEditor）
     * markdownEditor-> 与 textarea / preview / editor 同作用域，在此启动并挂预览刷新钩子
     * footer:end    -> 老版本缺少 markdownEditor 钩子时的兜底启动
     */
    public static function activate()
    {
        if (version_compare(Common::VERSION, '1.2.0', '<')) {
            throw new \Exception(_t('EditorImageSync 需要 Typecho 1.2.0 或更高版本'));
        }

        \Typecho\Plugin::factory('admin/header.php')->header = [self::class, 'renderHeader'];
        \Typecho\Plugin::factory('admin/write-js.php')->write = [self::class, 'renderWrite'];
        \Typecho\Plugin::factory('admin/editor-js.php')->markdownEditor = [self::class, 'renderEditor'];
        \Typecho\Plugin::factory('admin/footer.php')->end = [self::class, 'renderFallback'];

        return _t('EditorImageSync 已启用，请在写作页按 Ctrl+F5 刷新一次');
    }

    /**
     * 禁用插件：Typecho 会自动移除本插件注册的所有 handles
     */
    public static function deactivate()
    {
        return _t('EditorImageSync 已停用，编辑器恢复为原生行为');
    }

    /**
     * 配置面板
     */
    public static function config(Form $form)
    {
        $form->addInput(new Checkbox(
            'sync',
            ['1' => _t('启用')],
            ['1'],
            _t('行号滚动同步'),
            _t('停用 Typecho 原生的像素比例同步，改为按「源码行 → 预览锚点」对齐。文中有图片时强烈建议开启。')
        ));

        $form->addInput(new Checkbox(
            'numbering',
            ['1' => _t('启用')],
            ['1'],
            _t('图片编号对照'),
            _t('左侧图片链接行旁显示同号缩略图，右侧预览图左上角显示 #N 角标。')
        ));

        $form->addInput(new Checkbox(
            'clickToLocate',
            ['1' => _t('启用')],
            ['1'],
            _t('点击预览图片定位源码'),
            _t('点击右侧任意一张图，左侧跳到对应链接、光标落在右括号之后并聚焦，可直接接着输入。')
        ));

        $form->addInput(new Checkbox(
            'followCursor',
            ['1' => _t('启用')],
            ['1'],
            _t('光标段落跟随'),
            _t('光标所在段落在右侧高亮；若已滚出可视区，预览自动跟过去。')
        ));

        $form->addInput(new Checkbox(
            'showTag',
            ['1' => _t('启用')],
            ['1'],
            _t('预览角标'),
            _t('预览区右下角常驻「#N · 第 X 行」，滚到大图中间也知道在看哪一张。')
        ));

        $form->addInput(new Text(
            'thumbWidth',
            null,
            '68',
            _t('左侧缩略图条宽度'),
            _t('单位 px，默认 68。调小可减少遮挡，建议范围 40–160。')
        ));
    }

    /**
     * 个人用户配置（本插件不区分用户）
     */
    public static function personalConfig(Form $form)
    {
    }

    /**
     * header 钩子：追加样式表与宽度覆盖
     *
     * @param string $header
     * @return string
     */
    public static function renderHeader($header)
    {
        $settings = self::settings();
        $width = max(40, min(160, (int) $settings['thumbWidth']));

        $html = '<link rel="stylesheet" href="'
            . htmlspecialchars(self::assetUrl('editor-sync.css'), ENT_QUOTES, 'UTF-8')
            . '?v=1.0.1" />'
            . '<style>#wmd-img-lanes{width:' . $width . 'px}'
            . '.wmd-img-lane{width:' . ($width - 4) . 'px}</style>';

        return $header . "\n" . $html;
    }

    /**
     * write 钩子：先输出配置，再同步载入主脚本
     *
     * 此处 common-js.php 已加载 jQuery 与 typecho.js，
     * 因此 editor-sync.js 可以立即覆盖 window.scrollableEditor。
     */
    public static function renderWrite()
    {
        $settings = self::settings();
        $rootUrl = rtrim((string) Options::alloc()->rootUrl, '/');

        $config = [
            'enabled'       => true,
            'sync'          => (bool) $settings['sync'],
            'numbering'     => (bool) $settings['numbering'],
            'clickToLocate' => (bool) $settings['clickToLocate'],
            'followCursor'  => (bool) $settings['followCursor'],
            'showTag'       => (bool) $settings['showTag'],
            'rootUrl'       => $rootUrl
        ];

        echo '<script>window.TypechoEditorSyncConfig = '
            . json_encode($config, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
            . ';</script>' . "\n";

        echo '<script src="'
            . htmlspecialchars(self::assetUrl('editor-sync.js'), ENT_QUOTES, 'UTF-8')
            . '?v=1.0.1"></script>' . "\n";
    }

    /**
     * markdownEditor 钩子：输出的是纯 JS（本钩子位于 editor-js.php 的 <script> 内部）
     *
     * 该位置可直接访问 textarea / preview / editor 局部变量。
     * 整段包在 try 里：插件出错也绝不能影响编辑器本身初始化。
     *
     * @param mixed $content
     */
    public static function renderEditor($content = null)
    {
        echo <<<'JS'
try {
    (function () {
        var api = window.TypechoEditorSync;

        if (!api || typeof textarea === 'undefined' || typeof preview === 'undefined') {
            return;
        }

        var result = api.boot(textarea, preview);

        if (!result || typeof editor === 'undefined' || !editor.hooks) {
            return;
        }

        editor.hooks.chain('onPreviewRefresh', function () {
            api.reload();
        });

        ['enterFakeFullScreen', 'enterFullScreen', 'exitFullScreen'].forEach(function (hook) {
            editor.hooks.chain(hook, function () {
                setTimeout(function () { api.reload(); }, 60);
            });
        });

        editor.hooks.chain('commandExecuted', function () {
            setTimeout(function () { api.reload(); }, 30);
        });
    })();
} catch (e) {
    if (window.console && console.warn) {
        console.warn('[EditorImageSync] 初始化失败:', e);
    }
}
JS;
        echo "\n";
    }

    /**
     * footer:end 钩子：兜底启动
     *
     * 若 Typecho 版本没有 markdownEditor 钩子（或别的插件改写了编辑器），
     * 这里用 DOM 查询 + MutationObserver 启动，保证基本可用。
     */
    public static function renderFallback()
    {
        echo <<<'HTML'
<script>
(function () {
    if (!window.jQuery || !window.TypechoEditorSync || window.TypechoEditorSync.booted) {
        return;
    }

    window.jQuery(function () {
        if (window.TypechoEditorSync.booted) {
            return;
        }

        try {
            window.TypechoEditorSync.boot(null, null, {useObserver: true});
        } catch (e) {
            if (window.console && console.warn) {
                console.warn('[EditorImageSync] 兜底启动失败:', e);
            }
        }
    });
})();
</script>
HTML;
        echo "\n";
    }

    /**
     * 读取插件配置，未保存配置时回落到默认值
     */
    private static function settings(): array
    {
        $defaults = self::DEFAULTS;

        try {
            $config = Options::alloc()->plugin(self::NAME);

            foreach ($defaults as $key => $default) {
                $value = $config->$key;

                if (null === $value) {
                    continue;
                }

                if (is_bool($default)) {
                    $defaults[$key] = is_array($value)
                        ? in_array('1', $value)
                        : (bool) $value;
                } else {
                    $defaults[$key] = $value;
                }
            }
        } catch (\Throwable $e) {
            // 尚未保存配置或配置损坏：使用默认值
        }

        return $defaults;
    }

    /**
     * 生成插件静态资源 URL
     */
    private static function assetUrl(string $file): string
    {
        ob_start();
        Options::alloc()->pluginUrl(self::ASSETS . $file);
        return (string) ob_get_clean();
    }
}
