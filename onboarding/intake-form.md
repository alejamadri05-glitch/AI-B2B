# AI Receptionist: Onboarding Questionnaire

Send this to a new client (Google Form, Typeform or a 20-minute call). Each answer maps to a field in `clients/<slug>.json`.

## 1. Business basics
- Business name, as customers know it → `business_name`
- Main trade (HVAC, plumbing, electrical, roofing…) → `trade`
- City and state → `city_state`
- Main phone number customers should call → `phone`
- Website → `website`
- Brand color (hex code, or we take it from your logo) → `brand_color`
- What should the assistant be called? (default: Riley) → `agent_name`

## 2. Hours and service area
- Office hours, including Saturdays → `hours`
- Cities or counties you serve → `service_area.description`
- ZIP codes you serve (a full list avoids sending techs too far) → `service_area.zip_codes`

## 3. Services and pricing
- List your services, with one sentence each → `services`
- Service call / diagnostic fee, and when it's waived → `pricing.diagnostic_fee`
- After-hours, weekend or holiday fee → `pricing.after_hours_fee`
- Any other fixed prices you're OK sharing in chat (tune-ups, inspections) → `pricing`
- Financing options → `financing`
- Warranties and guarantees → `warranties`
- Prices the assistant must NEVER give (by default it never quotes repair or installation totals) → `pricing.notes`

## 4. Emergencies
- Do you offer 24/7 emergency service? → `emergency.available_24_7`
- What counts as an emergency for you? → `emergency.examples`
- Who gets alerted for emergencies (name, cell for SMS alerts) and how fast do you call back? → `emergency.on_call_response`, n8n alert flow
- Number to give customers who want to talk to a person → `escalation.transfer_phone`

## 5. Scheduling
- Arrival windows you offer (e.g. 8–11, 11–2, 2–5) → `booking.arrival_windows`
- Days you don't book regular jobs → `booking.closed_days`
- How many days ahead customers can book → `booking.days_ahead`
- Maximum jobs per window (roughly, the number of techs available) → `booking.jobs_per_window`
- Scheduling software (ServiceTitan, Housecall Pro, Jobber, Google Calendar, paper) → integration plan

## 6. FAQs
- The 5–10 questions your office gets most, with your answers → `faqs`

## 7. Notifications and reporting
- Where should new bookings and leads go? (SMS, email, Google Sheet, CRM) → n8n webhook flow
- Who should get the monthly report? → `report.email`
- What is your average ticket for a service visit? (used to estimate revenue in the report) → `report.avg_ticket`
- Exact office hours, when someone answers the phone → `office_hours`

## 8. Consent
- I confirm the information above is accurate and authorize the AI assistant to answer customers on our behalf using it. Name, title, date.
