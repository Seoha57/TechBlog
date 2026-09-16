---
layout: default
title: DBA
permalink: /categories/dba/
---
<section class="category-page"><p class="eyebrow">LEARNING TRACK 02</p><h1>DBA</h1><p>SQL과 데이터베이스 운영을 배우며 정리합니다.</p><div class="post-list">{% for post in site.posts %}{% if post.categories contains 'dba' %}<article class="post-card"><a href="{{ post.url | relative_url }}"><div class="post-meta"><span>DBA</span><time>{{ post.date | date: '%Y.%m.%d' }}</time></div><h3>{{ post.title }}</h3><p>{{ post.excerpt | strip_html | truncate: 140 }}</p><span class="read-more">Read article ↗</span></a></article>{% endif %}{% endfor %}</div></section>
