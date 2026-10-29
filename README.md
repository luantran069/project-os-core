# Project OS core

Lõi dùng chung để khởi chạy dự án phần mềm bằng một đội AI agent. Agent tự lập
kế hoạch chi tiết, code, kiểm tra và bàn giao. Chủ dự án chỉ duyệt ở bốn cổng:
hướng đi, kế hoạch tính năng, phát hành và nội dung công khai.

Phiên bản hiện tại: xem [`VERSION`](VERSION). Lõi v0 được rút ra từ quy trình
đang chạy thật trong [good-ideas](https://github.com/luantran069/good-ideas)
(Symphony + Codex + Jira), sau đó tách phần riêng của Investment Storylines ra.

## Lõi và dự án

Dự án **không fork** lõi. Dự án được tạo từ [`template/`](template/) và ghi
phiên bản lõi nó dùng trong `project.yaml`. Khi lõi có phiên bản mới, mỗi dự án
tự quyết định khi nào nâng cấp, giống cập nhật một thư viện.

```
project-os-core/          repo này
  agents/                 vai trò agent: nhiệm vụ, đầu vào, đầu ra, giới hạn quyền
  gates/                  bốn cổng duyệt và cách gắn nhãn trên tracker
  playbooks/              bài học dùng chung, rút từ các dự án
  template/               bộ khung cho dự án mới
  scripts/                tạo dự án mới, kiểm tra dự án
  docs/                   kiến trúc, cách đưa good-ideas về dùng lõi

my-app/                   một dự án tạo từ template
  project.yaml            phiên bản lõi, module bật/tắt, mức tự chủ, ngân sách
  AGENTS.md               luật làm việc cho agent trong repo này
  WORKFLOW.md             cấu hình Symphony và prompt cho agent code
  memory/                 tầm nhìn, quyết định, trạng thái, bài học
  docs/idea-planning-template.md
  marketing/brand.md
```

## Bắt đầu một dự án mới

Cần Node 22 trở lên. Không cần cài thêm gói nào.

```bash
node scripts/new-project.mjs ../my-app \
  --name "My App" --repo luantran069/my-app --tracker-key MA --owner "Luan Tran"
node scripts/check-project.mjs ../my-app
```

Sau đó mở `../my-app/memory/vision.md` và viết tầm nhìn. Đây là file duy nhất bắt
buộc người viết; agent đọc nó trước mọi việc.

## Bốn cổng duyệt

| Cổng | Câu hỏi                  | Bạn xem gì                                     | Có thể tự động hóa? |
| ---- | ------------------------ | ---------------------------------------------- | ------------------- |
| G1   | Có nên làm dự án này?    | Phiếu đánh giá của Strategist                  | Không               |
| G2   | Làm tính năng nào trước? | Thẻ tính năng ngắn có tiêu chí nghiệm thu      | Không               |
| G3   | Đưa lên production chưa? | Bản staging và ghi chú phát hành               | Có, khi test đủ tin |
| G4   | Đăng cái này ra ngoài?   | Bài viết, quảng cáo, video trước khi công khai | Không               |

Chi tiết và nhãn tracker tương ứng: [`gates/README.md`](gates/README.md).

## Tài liệu

- [Kiến trúc](docs/architecture.md): vòng đời, agent, mức tự chủ, bộ nhớ.
- [Đưa good-ideas về dùng lõi](docs/adopting-good-ideas.md): phần nào đã rút ra,
  phần nào còn lại trong good-ideas, các bước tiếp theo.
- [Vai trò agent](agents/README.md).
- [Playbook](playbooks/README.md).

## Kiểm tra lõi

```bash
npm test
```

Chạy bài test cho script tạo dự án và kiểm tra dự án.
