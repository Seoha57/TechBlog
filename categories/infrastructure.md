---
layout: default
title: Infrastructure
permalink: /categories/infrastructure/
---
<section class="category-page"><p class="eyebrow">LEARNING TRACK 03</p><h1>Infrastructure</h1><p>Linux, Kubernetes, 배포와 관측성을 배우며 정리합니다.</p><div class="post-list">{% for post in site.posts %}{% if post.categories contains 'infrastructure' %}<article class="post-card"><a href="{{ post.url | relative_url }}"><div class="post-meta"><span>INFRA</span><time>{{ post.date | date: '%Y.%m.%d' }}</time></div><h3>{{ post.title }}</h3><p>{{ post.excerpt | strip_html | truncate: 140 }}</p><span class="read-more">Read article ↗</span></a></article>{% endif %}{% endfor %}</div></section>
