---
layout: default
title: QA
permalink: /categories/qa/
---
<section class="category-page"><p class="eyebrow">LEARNING TRACK 01</p><h1>QA</h1><p>테스트 자동화와 품질 검증을 배우며 정리합니다.</p><div class="post-list">{% for post in site.posts %}{% if post.categories contains 'qa' %}<article class="post-card"><a href="{{ post.url | relative_url }}"><div class="post-meta"><span>QA</span><time>{{ post.date | date: '%Y.%m.%d' }}</time></div><h3>{{ post.title }}</h3><p>{{ post.excerpt | strip_html | truncate: 140 }}</p><span class="read-more">Read article ↗</span></a></article>{% endif %}{% endfor %}</div></section>
