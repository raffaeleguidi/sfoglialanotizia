// Middleware to inject auto-refresh script into HTML responses
module.exports = function injectAutoRefresh(req, res, next) {
    // Store the original render function
    const originalRender = res.render;

    // Override the render function
    res.render = function (view, options, callback) {
        // Call the original render with a callback to intercept the HTML
        originalRender.call(this, view, options, function (err, html) {
            if (err) {
                if (callback) {
                    return callback(err);
                }
                return next(err);
            }

            // Inject the auto-refresh script before the closing </body> tag
            const scriptTag = '<script src="/javascripts/auto-refresh.js"></script>';
            const modifiedHtml = html.replace('</body>', scriptTag + '\n</body>');

            if (callback) {
                callback(null, modifiedHtml);
            } else {
                res.send(modifiedHtml);
            }
        });
    };

    next();
};
