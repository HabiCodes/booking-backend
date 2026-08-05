import { eventRepository } from '../repositories/eventRepository';

export class EventService {
  async getActiveEvent() {
    return eventRepository.getActiveEvent();
  }

  async getEventById(id: number) {
    return eventRepository.getEventById(id);
  }

  async getBookingStats(eventId: number) {
    return eventRepository.getBookingStats(eventId);
  }
}

export const eventService = new EventService();
