---
layout: post
title: "Playwright MCP로 웹 테스트 자동화 시작하기"
date: 2026-09-16 00:00:00 +0900
categories: [qa]
tags: [qa, playwright, mcp, test-automation, ai]
---

QA 업무에서 테스트 자동화를 시작할 때 가장 먼저 생기는 질문은 “무엇을 자동화할 것인가”입니다. 모든 화면을 자동화하는 것보다, 반복 실행이 많고 결과가 명확한 시나리오부터 선택하는 편이 좋습니다.

이번 글에서는 Playwright MCP를 사용해 자연어로 웹 페이지를 탐색하고, 테스트에 필요한 브라우저 동작을 확인하는 흐름을 정리합니다. MCP는 테스트를 완전히 대신하는 도구가 아니라, 테스트 시나리오를 빠르게 탐색하고 초안을 만드는 보조 수단으로 접근합니다.

<section class="quick-answers">
  <p class="quick-label">먼저 답하면</p>
  <div class="quick-answer"><h3>Q. Playwright MCP가 테스트 코드를 완전히 대신하나요?</h3><p>A. 아닙니다. 브라우저 탐색과 시나리오 초안 작성에 적합하고, 반복 회귀 테스트는 사람이 검토한 Playwright 코드로 고정하는 편이 안전합니다.</p></div>
  <div class="quick-answer"><h3>Q. QA 엔지니어가 가장 먼저 적용할 곳은 어디인가요?</h3><p>A. 로그인, 검색, 결제 전 검증처럼 입력과 기대 결과가 명확하고 반복 실행이 많은 시나리오부터 시작하는 것이 좋습니다.</p></div>
  <div class="quick-answer"><h3>Q. 바로 운영 시스템에 연결해도 되나요?</h3><p>A. 테스트 계정과 비식별 데이터를 사용하는 별도 환경에서 검증한 뒤, 승인된 시나리오만 CI에 연결해야 합니다.</p></div>
</section>

![Playwright MCP 테스트 흐름]({{ '/assets/images/playwright-mcp-flow.svg' | relative_url }})

*이미지 출처: 직접 제작*

## Playwright MCP는 무엇인가

Playwright는 Chromium, Firefox, WebKit 기반의 브라우저 자동화와 end-to-end 테스트를 지원하는 도구입니다. 공식 문서는 페이지 이동, locator, assertion, trace와 같은 기능을 테스트 코드로 제공하며, 브라우저 동작을 재현할 수 있도록 구성되어 있습니다.

Playwright MCP는 MCP 서버를 통해 AI 클라이언트가 브라우저를 조작하도록 연결합니다. 예를 들어 “로그인 페이지를 열고 잘못된 비밀번호를 입력한 뒤 오류 메시지를 확인해줘”처럼 요청할 수 있습니다.

이 방식의 장점은 테스트 대상의 화면과 흐름을 빠르게 파악할 수 있다는 점입니다. 반면 자연어 요청만으로 품질을 보장할 수는 없습니다. 최종 회귀 테스트에는 명시적인 locator와 assertion을 가진 코드가 필요합니다.

## 설치와 기본 설정

Playwright 테스트 프로젝트는 다음 명령으로 시작할 수 있습니다.

```bash
npm init playwright@latest
npx playwright install
```

MCP 클라이언트에는 Playwright MCP 서버를 연결합니다. 클라이언트별 설정 형식은 다를 수 있으므로 사용하는 도구의 설정 파일 형식을 확인해야 합니다.

설정 후에는 다음과 같은 시나리오로 동작을 확인할 수 있습니다.

```text
1. 테스트 사이트를 연다.
2. 검색 입력창에 "PostgreSQL"을 입력한다.
3. 검색 버튼을 누른다.
4. 결과 목록에 PostgreSQL이 포함되어 있는지 확인한다.
5. 결과 화면을 캡처한다.
```

처음부터 복잡한 업무 시스템을 대상으로 하기보다, 입력·클릭·검증 결과가 분명한 작은 페이지로 시작하는 편이 좋습니다.

## QA 테스트에 적용하는 방법

MCP를 사용한 탐색 결과는 테스트 케이스 초안으로 활용할 수 있습니다. 예를 들어 로그인 테스트라면 정상 로그인, 잘못된 비밀번호, 필수값 누락, 세션 만료를 나누어 확인합니다.

그 다음 반복 실행이 필요한 시나리오를 Playwright 코드로 고정합니다.

```ts
import { test, expect } from '@playwright/test';

test('검색 결과에 PostgreSQL이 표시된다', async ({ page }) => {
  await page.goto('https://example.com');
  await page.getByRole('searchbox').fill('PostgreSQL');
  await page.getByRole('button', { name: '검색' }).click();

  await expect(page.getByText('PostgreSQL')).toBeVisible();
});
```

핵심은 “AI가 테스트를 만들었다”가 아니라, 사람이 검증 가능한 조건을 코드로 남기는 데 있습니다. locator가 지나치게 화면 구조에 의존하지 않는지, assertion이 실제 업무 결과를 검증하는지도 함께 확인해야 합니다.

## 한계와 적용 기준

<section class="quick-answers">
  <p class="quick-label">실무 적용 Q&A</p>
  <div class="quick-answer"><h3>Q. Playwright MCP의 결과를 바로 테스트 결과로 봐도 되나요?</h3><p>A. 안 됩니다. 같은 요청이라도 페이지 상태나 locator 선택에 따라 결과가 달라질 수 있습니다. MCP 결과는 탐색과 초안으로 보고, 최종 결과는 명시적인 assertion을 가진 코드로 다시 확인해야 합니다.</p></div>
  <div class="quick-answer"><h3>Q. MCP와 Playwright 코드는 어떻게 나누어 사용하나요?</h3><p>A. MCP는 신규 기능 탐색과 재현 절차 확인에 사용하고, Playwright 코드는 반복 회귀 테스트와 CI 실행에 사용합니다. QA 리뷰는 기대 결과와 예외 조건, 데이터 정합성을 최종 확인합니다.</p></div>
  <div class="quick-answer"><h3>Q. 개인정보가 있는 운영 환경에서도 사용할 수 있나요?</h3><p>A. 테스트 계정과 비식별 데이터를 사용하는 별도 환경을 우선해야 합니다. 로그인 정보나 개인정보가 포함된 화면을 AI 도구에 전달하지 않도록 데이터 범위와 접근 권한을 먼저 제한해야 합니다.</p></div>
  <div class="quick-answer"><h3>Q. 도입은 어디서 시작하는 것이 좋나요?</h3><p>A. 로그인, 검색처럼 입력과 기대 결과가 명확한 작은 시나리오부터 시작합니다. 재현성과 안정성이 확인된 흐름만 자동화 테스트로 승격하면 유지보수 비용을 줄일 수 있습니다.</p></div>
</section>

결국 MCP는 QA 엔지니어의 판단을 대체하는 도구가 아니라, 브라우저를 직접 확인하는 시간을 줄여주는 도구에 가깝습니다.

### 참고 자료

- [Playwright MCP 공식 문서](https://playwright.dev/docs/getting-started-mcp)
- [Playwright 공식 문서](https://playwright.dev/docs/intro)
- [Model Context Protocol 공식 문서](https://modelcontextprotocol.io/introduction)
