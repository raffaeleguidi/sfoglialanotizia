// Auto-refresh when tab regains focus after 5 minutes in background
(function () {
    var backgroundStartTime = 0;
    var REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            // Tab is now in background
            backgroundStartTime = Date.now();
        } else {
            // Tab is now in foreground
            if (backgroundStartTime > 0) {
                var elapsed = Date.now() - backgroundStartTime;
                if (elapsed > REFRESH_THRESHOLD_MS) {
                    console.log('Auto-refreshing after ' + Math.round(elapsed / 1000) + ' seconds in background');
                    window.location.reload();
                }
                backgroundStartTime = 0;
            }
        }
    });
})();
