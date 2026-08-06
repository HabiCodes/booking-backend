"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateBookingPdf = generateBookingPdf;
const pdfkit_1 = __importDefault(require("pdfkit"));
const qrcode_1 = __importDefault(require("qrcode"));
async function generateBookingPdf(payload) {
    const { event, tickets, bannerImage } = payload;
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new pdfkit_1.default({
                size: 'A4',
                margin: 40,
                info: {
                    Title: `Tickets - ${event.title}`,
                    Author: 'Event Booking Platform',
                },
            });
            const chunks = [];
            doc.on('data', (chunk) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
            // Header
            doc
                .rect(0, 0, doc.page.width, 80)
                .fill('#1a1a2e');
            doc
                .fillColor('#ffffff')
                .fontSize(22)
                .font('Helvetica-Bold')
                .text(event.title, 40, 28, { align: 'left', width: doc.page.width - 80 });
            doc
                .fontSize(10)
                .font('Helvetica')
                .text(event.venue, 40, 56, { align: 'left' });
            // Tickets
            for (let i = 0; i < tickets.length; i++) {
                const ticket = tickets[i];
                if (i > 0)
                    doc.addPage();
                await drawTicketPage(doc, event, ticket, bannerImage);
            }
            doc.end();
        }
        catch (err) {
            reject(err);
        }
    });
}
async function drawTicketPage(doc, event, ticket, bannerImage) {
    const margin = 40;
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const cardX = margin;
    const cardY = 100;
    const cardW = pageWidth - margin * 2;
    const cardH = pageHeight - 160;
    // Card background
    doc
        .roundedRect(cardX, cardY, cardW, cardH, 12)
        .lineWidth(1)
        .strokeColor('#e5e7eb')
        .stroke();
    // Top accent strip
    doc
        .rect(cardX, cardY, cardW, 6)
        .fill('#a21caf');
    // Event title
    doc
        .fillColor('#111827')
        .fontSize(20)
        .font('Helvetica-Bold')
        .text(event.title, cardX + 24, cardY + 24, { width: cardW - 48 });
    // Venue and date
    doc
        .fontSize(11)
        .font('Helvetica')
        .fillColor('#6b7280')
        .text(event.venue, cardX + 24, cardY + 50);
    doc
        .fillColor('#374151')
        .font('Helvetica-Bold')
        .text(formatEventDate(event.start_at), cardX + 24, cardY + 68);
    // Divider
    doc
        .moveTo(cardX + 24, cardY + 100)
        .lineTo(cardX + cardW - 24, cardY + 100)
        .strokeColor('#e5e7eb')
        .stroke();
    // Attendee label
    doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#9ca3af')
        .text('ATTENDEE', cardX + 24, cardY + 116);
    doc
        .fontSize(16)
        .font('Helvetica-Bold')
        .fillColor('#111827')
        .text(ticket.attendee_name, cardX + 24, cardY + 130);
    // Details row
    let y = cardY + 168;
    doc.fontSize(10).font('Helvetica').fillColor('#9ca3af');
    doc.text('PHONE', cardX + 24, y);
    doc.text('AGE', cardX + 220, y);
    doc.text('GENDER', cardX + 340, y);
    y += 16;
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#111827');
    doc.text(ticket.attendee_phone, cardX + 24, y);
    doc.text(ticket.attendee_age?.toString() || '-', cardX + 220, y);
    doc.text(ticket.attendee_gender || '-', cardX + 340, y);
    // QR Code
    const qrSize = 200;
    const qrX = cardX + (cardW - qrSize) / 2;
    const qrY = cardY + 230;
    const qrDataUrl = await qrcode_1.default.toDataURL(ticket.ticket_uuid, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: qrSize * 2, // 2x for retina
    });
    const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
    // UUID below QR
    doc
        .fontSize(9)
        .font('Courier')
        .fillColor('#6b7280')
        .text(`UUID: ${ticket.ticket_uuid}`, cardX + 24, qrY + qrSize + 8, {
        width: cardW - 48,
        align: 'center',
    });
    // Active banner at the bottom of each ticket page
    if (bannerImage) {
        const bannerHeight = 60;
        const bannerY = pageHeight - margin - bannerHeight;
        const bannerWidth = pageWidth - margin * 2;
        try {
            doc.image(bannerImage, cardX, bannerY, {
                width: bannerWidth,
                height: bannerHeight,
                fit: [bannerWidth, bannerHeight],
            });
        }
        catch {
            // If image render fails, silently skip — banner is promotional, not critical
        }
    }
    // Footer notice
    doc
        .fontSize(8)
        .font('Helvetica')
        .fillColor('#9ca3af')
        .text('Present this QR code at the venue entrance.', cardX + 24, cardY + cardH - 32, {
        width: cardW - 48,
        align: 'center',
    });
}
function formatEventDate(date) {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleString('en-IN', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}
