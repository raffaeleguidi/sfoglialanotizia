var express = require('express');
var router = express.Router();

var _ = require('lodash');
var jsonfile = require('jsonfile')
var feeds = require('../lib/feeds');
var cache = require('memory-cache');

feeds.init(cache);

/* GET home page. */
router.get('/', function(req, res, next) {
    const data = feeds.load();
    res.render('index', { title: "Sfoglia la Notizia!", 
        articles: _.filter(data.articles, function(article){ return article.totalWeight > 0 }), 
        corpus: data.corpus, 
        sources: data.sources,
        status: data.status,
        minSim: 0.00, minConf: 0 
        //minSim: 0.09, minConf: 2 
    });
});

module.exports = router;
