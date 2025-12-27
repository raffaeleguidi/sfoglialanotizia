var FeedParser = require('feedparser');
var request = require('request'); // for fetching the feed
var moment = require('moment');
var htmlToText = require('html-to-text');
var cheerio = require('cheerio');

var _ = require('lodash');
var jsonfile = require('jsonfile')
var fs = require('fs');
var cache = require('memory-cache');
var sentiment = require("sentiment-multilang")

const loadSource = function(name, url, label, encoding, cb){
        var feedparser = new FeedParser({ normalize: true });
        var req = request(url, {encoding: encoding})

        var articles = new Array();

        req.on('response', function (res) {
          var stream = this; // `this` is `req`, which is a stream

          if (res.statusCode !== 200) {
            this.emit('error', new Error('Bad status code ' + res.statusCode + ' for ' + url));
          }
          else {
            stream.pipe(feedparser);
          }
        });

        var position = 0;
        feedparser.on('readable', function () {
          var stream = this; // `this` is `feedparser`, which is a stream
          var meta = this.meta; // **NOTE** the "meta" is always available in the context of the feedparser instance
          var item;

          while (item = stream.read()) {
              var images = new Array();

              //console.log(item)

              if (item.description) {
                  const $ = cheerio.load(item.description);

                  $('img').each(function(){
                      images.push($(this).attr('src'))
                  });
                  var media = item.enclosures[0] ? item.enclosures[0] : null;
              }
              if (item["rss:photo"]) {
                  images.push(item["rss:photo"]["#"])
              }


              var myDesc = item.description ?
                        htmlToText.fromString(item.description, {ignoreImage: true, ignoreHref: true})
                        : item.summary


              moment.locale("it")

              if (item.pubDate == "Invalid Date") {
                  item.pubDate = item["rss:pubdate"]["#"].toLowerCase();
                  item.pubDate = moment(item.pubDate, "ddd, ll HH:mm:ss Z");
                  //Lun, 05 Giu 2017 11:10:40 +0200
              } else {
                item.pubDate = moment(item.pubDate);
              } 
              item.published = moment(item.pubDate).format("[h]HH:mm DD/MM/YYYY");

                        
              articles.push({
                  position: ++position,
                  source: name,
                  label: label,
                  title: item.title,
                  pubDate: item.pubDate,
                  published: item.published,
                  url: item.link,
                  images: images,
                  description: myDesc
              });
          }
        });

        function done(){
            _.each(articles, function(article){
                article.weight = Math.max(100 - ((article.position - 1) * 10), 0);
            })
            cb({ name: name, url: url, articles: articles.slice(0, 15) })
        }

        feedparser.on('error', function(err){
          console.error("error", err);
          cb({ name: name, url: url, articles: articles })
        });
        feedparser.on('end', done);
  }

function lean(str, stopwords){
    var ret = str ?
        str.toLowerCase()
            .replace(/&nbsp;/g, ' ')
            .replace(/["]/g, '').replace(/[«]/g, '').replace(/[»]/g, '')
            .replace(/[\.]/g, '').replace(/[,]/g, '').replace(/[-]/g, '')
            .replace(/[“]/g, '').replace(/[”]/g, '').replace(/[:]/g, '')
            .replace(/[\']/g, ' ').replace(/[\?]/g, '').replace(/[!]/g, '')
            .replace(/[|]/g, ' ').replace(/[\’]/g, ' ').replace(/[;]/g, '')
            .replace(/[\(]/g, '').replace(/[\)]/g, '').replace(/[-]/g, '')
        : null

    if (ret) {
        var tmp = ret.split(" ");
        var tmp2 = _.filter(tmp, function(item){
            const tmp3 = item.trim()
            return tmp3.length > 3 && stopwords.indexOf(tmp3) < 0;
        })
        return tmp2;
    }
    return null;
}

function computeSimilarity(articles, corpus, cb){
    console.log("processing text");

    _.each(_.sortBy(articles, "position"), function(a){
        _.each(articles, function(b){
            if (a.links[b.url] || b.links[a.url] || a === b)
                return;
            var similarity1 = 0;

            const leanA = lean(a.title + " " + a.description, stopwords);
            const leanB = lean(b.title + " " + b.description, stopwords)
            var totT = (leanA ? leanA.length : 0) + (leanB ? leanB.length : 0);
            const minT = ((leanA ? leanA.length : 0)  + (leanB ? leanB.length : 0)) / 2;
            const iTarray = _.intersection(leanA, leanB);
            const iT = iTarray.length;
            similarity1 =  minT > 0 ? iT / minT : 0;
            similarity1 =  iT;

            const similarity = similarity1 / totT;
            a.links[b.url] = similarity;
            b.links[a.url] = a.links[b.url];
            if (!a.relations) a.relations = {};
            if (!b.relations) b.relations = {};

            a.relations[b.url] =iTarray;
            b.relations[a.url] = a.relations[b.url];
            a.confidence[b.url] = similarity1;
            b.confidence[a.url] = a.confidence[b.url];
        })
    })

    _.each(articles, function(article){
        var tmp = new Array();
        _.forOwn(article.links, function(value, key) {
            tmp.push({ url: key, similarity: value});
        })
        article.related = _.sortBy(tmp, "similarity").reverse().slice(0, 5);
        delete article.links;
    })

    console.log("processed", articles.length, "articles");
    return articles;
}

const loadSources = function(sources, stopwords, cb) {
    var corpus;
    var articles = new Array();

    var loadedFeeds = 0;

    _.each(sources, function(feed){
        console.log("feed:", feed.name)
        loadSource(feed.name, feed.url, feed.label, feed.encoding || "utf-8", function(loaded){
            console.log(feed.name, "count:", loaded.articles.length)
            _.each(loaded.articles, function(item){
                item.links = {};
                item.confidence = {};
                if (item.description) item.description = item.description.replace(/[\r\n]/g, ' ')
                articles.push(item);
            })
            loadedFeeds++;
            console.log("loaded", loadedFeeds, "feeds", "out of", sources.length);
            if (loadedFeeds == sources.length){
                cb(articles, _.keyBy(articles, 'url'))
            }
        })
    });
}

function computeTotalWeight(articles, corpus, minSim, minConf){
    _.each(articles, function(article){
        article.totalWeight = article.weight;
        for(i in article.related){
            related = article.related[i];
            if ((article.confidence[related.url] >= minConf && related.similarity >= minSim) || article.confidence[related.url] >= (minConf * 2) || related.similarity >= (minSim * 2)){
                article.totalWeight += corpus[related.url].weight;
            } else {
                article.confidence[related.url] = -1;
            }
        }
    });
    return _.sortBy(articles, "totalWeight").reverse();
}

function markDuplicates(articles){
    var alreadyShown = {};
    _.each(articles, function(article){
        if (!alreadyShown[article.url]) {
            alreadyShown[article.url] = true;
            for(i in article.related){
                related = article.related[i];
                if (article.confidence[related.url] >= 0) {
                    alreadyShown[related.url] = true;
                }
            }
        } else {
            article.alreadyShown = true;
        }
    });
}

function refineText(articles){
    _.each(articles, function(a){
        if (a.title) {
            a.title = a.title.replace(/l\?/g,"'");
            a.title = a.title.replace(/&#39;/g,"'");
        }
        if (a.description) {
            a.description = a.description.replace(/--/g,"");
            a.description = a.description.replace(/l\?/g,"l'");
            a.description = a.description.replace(/&#39;/g,"'");
            if (a.description.length > 300) a.description = a.description.substring(0, 300) + "..";
        }
    });
}

function addOverallNumbering(articles){
    var n = 0;
    _.each(articles, function(a){
        if (!a.alreadyShown) {
            if (n < 1) {
                a.overallPosition = "top";
            } else if (n < 3) {
                a.overallPosition = "highlight";
            } else if (n < 14) {
                a.overallPosition = "body";
            } else if (!(n < 14)) {
                a.overallPosition = "other";
            }
            n++;
        }
    });
}

const addSentiment = articles => {
    evaluate = phrase => {
        var res = sentiment(phrase, 'it')
        return { score: res.score, vote: res.vote, comparative: res.comparative.toFixed(2) }
    }

    var n = 0;
    _.each(articles, function(a){
        a.sentiment = evaluate(a.title + " " + a.description)
    });
}

// see https://xiamx.github.io/node-nltk-stopwords/
const stopwords = ["altro", "altra", "seconda", "secondo", "infatti", "quel", "quella", "stato", "loro", "dagli", "sulla", "sulle", "sull", "sullo", "dall", "avrò", "avrà", "avrebbe", "vuole", "ecco", "dalle", "suoi", "molto", "nell", "quei", "stare", "dello", "ancora", "altri", "prima", "primo", "mese", "mesi", "questo", "questi", "oltre", "doveva", "dovevano", "avevano", "erano", "ogni", "sempre", "dove", "questo", "proprio", "questa", "dare", "molti", "perché", "qualche", "allo", "fatte", "fatti", "fatto", "dalla", "tutto", "tutti", "anni", "così", "aveva", "hanno", "fare", "stata", "troppo", "meglio", "essere", "degli", "anche", "quando", "sono", "dice", "senza", "come", "cosa", "durante", "contro", "aver", "nessun", "quello", "alle", "agli", "nelle", "delle", "nella", "della", "alla", "sulle", "sulla", "sugli", "negli", "dopo", "dell"];

var sources, cache;

module.exports = {
    init: function(_cache){
        sources = jsonfile.readFileSync("sources.json");
        cache = _cache;
    },
    refresh: function(cb){
        console.log("collecting and computing data")
        loadSources(sources, stopwords, function(articles, corpus){
            // start processing pipeline
            refineText(articles);
            computeSimilarity(articles, corpus);
            articles = computeTotalWeight(articles, corpus, 0.05, 2);
            markDuplicates(articles);
            addOverallNumbering(articles);
            addSentiment(articles);
            // end pipeline
            jsonfile.writeFileSync("data/articles.json", articles);
            jsonfile.writeFileSync("data/corpus.json", corpus);
            const status = { lastUpdate: new Date(), count: articles.length };
            jsonfile.writeFileSync("data/status.json", status);
            if (cache) {
                cache.put("data", {
                    articles: articles, 
                    corpus: corpus, 
                    sources: sources, 
                    status: status
                }, 60 * 1000, function(key, value){
                    console.log(new Date(), key, "expired");
                });
            }
            if (cb) cb(articles, corpus, sources, status);
        })
    },
    loadFromDisk: function(){
        console.log("loading from disk");
        const data = {
            articles: jsonfile.readFileSync("data/articles.json"), 
            corpus: jsonfile.readFileSync("data/corpus.json"), 
            sources: sources,
            status: jsonfile.readFileSync("data/status.json")
        }
        if (cache) cache.put("data", data, 60 * 1000, function(key, value){
            console.log(new Date(), key, "expired");
        }); 
        return data;
    },
    load: function(cb){
        return cache.get("data") || this.loadFromDisk();
    }
}

