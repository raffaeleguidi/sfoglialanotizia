const express = require('express');
const router = express.Router();
const _ = require('lodash');
const feeds = require('../lib/feeds');
const cache = require('memory-cache');

feeds.init(cache);

/* GET home page. */
router.get('/', (req, res, next) => {
    const data = feeds.load();
    if (!data || !data.articles) {
        // Handle case where data isn't loaded yet
        return res.render('index', {
            title: "Sfoglia la Notizia!",
            articles: [],
            corpus: {},
            sources: [],
            status: {},
            minSim: 0.00,
            minConf: 0
        });
    }

    res.render('index', {
        title: "Sfoglia la Notizia!",
        articles: _.filter(data.articles, (article) => article.totalWeight > 0),
        corpus: data.corpus,
        sources: data.sources,
        status: data.status,
        minSim: 0.00,
        minConf: 0
    });
});

module.exports = router;
