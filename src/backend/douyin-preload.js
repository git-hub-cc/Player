// 这个脚本将在隐藏的浏览器窗口的页面上下文中执行
// 它的唯一目的就是欺骗网站的机器人检测机制

// 这是最关键的一步，将 navigator.webdriver 属性设置为 false
// 很多网站通过检查这个值为 true 来判断是否为自动化浏览器
Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
});