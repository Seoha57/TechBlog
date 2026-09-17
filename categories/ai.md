---
layout: default
title: AI
permalink: /categories/ai/
---

<section class="category-page"><p class="eyebrow">LEARNING TRACK 04</p><h1>AI</h1><p>LLM과 AI 에이전트의 기본 개념, 업무 적용과 검증 방법을 배우며 정리합니다.</p><div class="post-list">{% for post in site.posts %}{% if post.categories contains 'ai' %}<article class="post-card"><a href="{{ post.url | relative_url }}"><div class="post-meta"><span>AI</span><time>{{ post.date | date: '%Y.%m.%d' }}</time></div><h3>{{ post.title }}</h3><p>{{ post.excerpt | strip_html | truncate: 140 }}</p><span class="read-more">Read article ↗</span></a></article>{% endif %}{% endfor %}</div></section>
