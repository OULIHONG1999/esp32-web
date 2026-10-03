/* 链接即入口 · 预览页（当前为静态展示，预留交互） */
(function () {
  // 复制链接按钮示意
  document.querySelectorAll(".btn-primary.small").forEach(function (btn) {
    if (btn.textContent.indexOf("复制") === -1) return;
    btn.addEventListener("click", function () {
      var box = btn.parentElement && btn.parentElement.querySelector("code");
      var text = box ? box.textContent : "";
      if (navigator.clipboard && text) {
        navigator.clipboard.writeText(text).then(function () {
          var old = btn.textContent;
          btn.textContent = "已复制";
          setTimeout(function () {
            btn.textContent = old;
          }, 1200);
        });
      }
    });
  });
})();
